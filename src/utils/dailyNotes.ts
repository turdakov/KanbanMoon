import type { App, TFile } from 'obsidian'
import type KanbanMoonlightPlugin from '../main'
import type { HistoryEventCreated } from '../types/history'
import { getToday } from './history'

const CHECKBOX_LINE_REGEX = /^(\s*[-*]\s*\[\s\]\s*)(.+)$/
const DAILY_NOTE_NAME_REGEX = /^\d{4}-\d{2}-\d{2}$/

export interface DailyNoteTaskLine {
	lineIndex: number
	text: string
}

function normalizeFolderPrefix(folder: string): string {
	return folder ? folder.replace(/^\/+/, '').replace(/\/?$/, '/') : ''
}

export function getDailyNoteDateString(date: Date = new Date()): string {
	const year = date.getFullYear()
	const month = String(date.getMonth() + 1).padStart(2, '0')
	const day = String(date.getDate()).padStart(2, '0')
	return `${year}-${month}-${day}`
}

export function getDailyNoteFilePath(
	folder: string,
	date: Date = new Date(),
): string {
	return `${normalizeFolderPrefix(folder)}${getDailyNoteDateString(date)}.md`
}

export function resolveDailyNoteFile(
	app: App,
	folder: string,
	date: Date = new Date(),
): TFile | null {
	return app.vault.getFileByPath(getDailyNoteFilePath(folder, date))
}

export function isDailyNoteFile(
	file: Pick<TFile, 'path' | 'basename'>,
	folder: string,
): boolean {
	const normalizedFolder = normalizeFolderPrefix(folder)
	if (normalizedFolder && !file.path.startsWith(normalizedFolder)) {
		return false
	}
	return DAILY_NOTE_NAME_REGEX.test(file.basename)
}

/**
 * Finds the line range to scan for tasks. With no heading, the whole note
 * is scanned. With a heading, only the lines under it are scanned, up to
 * the next heading of the same or a shallower level.
 */
export function findDailyNoteSection(
	lines: string[],
	heading: string,
): { start: number; end: number } {
	const normalizedHeading = heading.trim().replace(/^#+\s*/, '').toLowerCase()
	if (!normalizedHeading) return { start: 0, end: lines.length }

	let sectionStart = -1
	let sectionLevel = 0

	for (let i = 0; i < lines.length; i++) {
		const match = /^(#{1,6})\s+(.*)$/.exec(lines[i] ?? '')
		if (!match) continue

		const level = match[1]?.length ?? 0
		const text = (match[2] ?? '').trim().toLowerCase()

		if (sectionStart === -1) {
			if (text === normalizedHeading) {
				sectionStart = i + 1
				sectionLevel = level
			}
		} else if (level <= sectionLevel) {
			return { start: sectionStart, end: i }
		}
	}

	return sectionStart === -1
		? { start: 0, end: 0 }
		: { start: sectionStart, end: lines.length }
}

/**
 * Extracts unchecked `- [ ] ...` task lines from a daily note's content.
 * Lines already containing a wikilink are skipped, since that marks a task
 * that was already imported into the backlog.
 */
export function extractUncheckedTaskLines(
	content: string,
	heading: string,
): DailyNoteTaskLine[] {
	const lines = content.split('\n')
	const { start, end } = findDailyNoteSection(lines, heading)
	const tasks: DailyNoteTaskLine[] = []

	for (let i = start; i < end; i++) {
		const match = CHECKBOX_LINE_REGEX.exec(lines[i] ?? '')
		if (!match) continue

		const text = (match[2] ?? '').trim()
		if (!text || text.includes('[[')) continue

		tasks.push({ lineIndex: i, text })
	}

	return tasks
}

export function sanitizeTaskTitle(text: string): string {
	return text.replace(/[\\/:*?"<>|#]/g, '-').trim()
}

export async function getAvailableTaskFilePath(
	app: App,
	folder: string,
	title: string,
): Promise<string> {
	const sanitized = sanitizeTaskTitle(title) || 'Task'
	const normalizedFolder = normalizeFolderPrefix(folder)

	let suffix = 0
	let path = `${normalizedFolder}${sanitized}.md`
	while (app.vault.getFileByPath(path)) {
		suffix++
		path = `${normalizedFolder}${sanitized} (${suffix}).md`
	}

	return path
}

async function createBacklogTaskFromText(
	app: App,
	plugin: KanbanMoonlightPlugin,
	text: string,
): Promise<TFile | null> {
	const board = plugin.getActiveBoard()
	const filePath = await getAvailableTaskFilePath(
		app,
		board.folderNotes,
		text,
	)

	const folderPath = filePath.includes('/')
		? filePath.substring(0, filePath.lastIndexOf('/'))
		: ''
	if (folderPath && !app.vault.getFolderByPath(folderPath)) {
		await app.vault.createFolder(folderPath)
	}

	const file = await app.vault.create(filePath, '')
	const backlogColumn = board.columns[0]
	const backlogId = backlogColumn?.id || 'backlog'

	await app.fileManager.processFrontMatter(file, (frontmatter) => {
		const fm = frontmatter as Record<string, unknown>
		fm['tags'] = [board.tagNotes.replace('#', '')]
		fm[board.propertyState || 'state'] = backlogId

		const createdEvent: HistoryEventCreated = {
			type: 'created',
			date: getToday(),
			column: backlogColumn?.title || backlogId,
		}
		fm['history'] = [createdEvent]
	})

	return file
}

/**
 * Scans a daily note for unchecked tasks and creates a backlog note for
 * each one found. Imported lines are rewritten as a link to the new note
 * so they are not imported again on a later scan.
 */
export async function importTasksFromDailyNote(
	app: App,
	plugin: KanbanMoonlightPlugin,
	file: TFile,
): Promise<number> {
	const content = await app.vault.read(file)
	const tasks = extractUncheckedTaskLines(
		content,
		plugin.settings.dailyNotesHeading,
	)
	if (tasks.length === 0) return 0

	const lines = content.split('\n')
	let imported = 0

	for (const task of tasks) {
		const createdFile = await createBacklogTaskFromText(
			app,
			plugin,
			task.text,
		)
		if (!createdFile) continue

		const line = lines[task.lineIndex] ?? ''
		const prefixMatch = /^(\s*[-*]\s*\[\s\]\s*)/.exec(line)
		const prefix = prefixMatch?.[1] ?? '- [ ] '
		lines[task.lineIndex] = `${prefix}[[${createdFile.basename}]]`
		imported++
	}

	if (imported > 0) {
		await app.vault.modify(file, lines.join('\n'))
	}

	return imported
}
