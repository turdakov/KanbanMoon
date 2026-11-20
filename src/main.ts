import { Plugin, Notice, TFile } from 'obsidian'
import {
	IKanbanSettings,
	DEFAULT_SETTINGS,
	getActiveBoard,
} from './settings/kanbanSettings'
import { migrateSettings } from './settings/migration'
import { KanbanMoonlightSettingTab } from './settings/settingsTab'
import { KanbanMoonlightView, VIEW_TYPE_KANBAN } from './views/kanbanView'
import { CreateTaskModal } from './ui/createTaskModal'
import { DeleteConfirmModal } from './ui/deleteConfirmModal'
import { normalizeTag } from './views/renderKanban/utils'
import { t } from './lang/helpers'
import { toSafeFm, getFmStringArray } from './utils/frontmatter'
import {
	extractUncheckedTaskLines,
	filterStableTasks,
	importTaskLines,
	importTasksFromDailyNote,
	isDailyNoteFile,
	resolveDailyNoteFile,
	type PendingTaskTexts,
} from './utils/dailyNotes'

export default class KanbanMoonlightPlugin extends Plugin {
	settings: IKanbanSettings = DEFAULT_SETTINGS
	private refreshTimer: number | null = null
	private dailyNoteImportTimers: Map<string, number> = new Map()
	private dailyNotePendingTasks: Map<string, PendingTaskTexts> = new Map()

	getActiveBoard() {
		return getActiveBoard(this.settings)
	}

	async onload() {
		await this.loadSettings()

		// Registrar la Vista pasando "this" (el plugin) como argumento
		this.registerView(
			VIEW_TYPE_KANBAN,
			(leaf) => new KanbanMoonlightView(leaf, this),
		)
		// 2. AÑADIR EL ICONO A LA BARRA LATERAL (RIBBON)
		// Usamos el icono 'lucide-kanban' (Obsidian incluye la librería Lucide Icons)
		this.addRibbonIcon(
			'lucide-kanban',
			t('VIEW_TITLE'),
			(_evt: MouseEvent) => {
				void this.activeView()
			},
		)

		this.addCommand({
			id: 'create-new-kanban-task',
			name: t('CREATE_TASK_TITLE'),
			callback: () => {
				new CreateTaskModal(this.app, this).open()
			},
		})

		this.addCommand({
			id: 'delete-kanban-task',
			name: t('DELETE_BTN') + ' ' + t('VIEW_TITLE'),
			callback: async () => {
				const activeFile = this.app.workspace.getActiveFile()
				if (!activeFile) {
					new Notice(t('NOTE_NOT_FOUND'))
					return
				}

				const cache = this.app.metadataCache.getFileCache(activeFile)
				const fm = toSafeFm(cache)
				const board = this.getActiveBoard()
				const hasTag = getFmStringArray(fm, 'tags').some((tag) =>
					normalizeTag(tag).startsWith(normalizeTag(board.tagNotes)),
				)

				const folder = board.folderNotes
				const inFolder =
					folder &&
					activeFile.path.startsWith(
						folder.replace(/^\/+/, '').replace(/\/?$/, '/'),
					)

				if (!hasTag && !inFolder) {
					new Notice(t('NOTICE_NOT_KANBAN'))
					return
				}

				new DeleteConfirmModal(this.app, this, activeFile).open()
			},
		})

		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				const cache = this.app.metadataCache.getFileCache(file)
				const fm = toSafeFm(cache)
				const board = this.getActiveBoard()
				const hasTag = getFmStringArray(fm, 'tags').some((tag) =>
					normalizeTag(tag).startsWith(normalizeTag(board.tagNotes)),
				)
				const folder = board.folderNotes
				const inFolder =
					folder &&
					file.path.startsWith(
						folder.replace(/^\/+/, '').replace(/\/?$/, '/'),
					)
				if (hasTag || inFolder) {
					this.refreshView()
				}
			}),
		)

		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				this.refreshView()
			}),
		)

		this.addCommand({
			id: 'import-daily-note-tasks',
			name: t('DAILY_NOTES_IMPORT_BTN'),
			callback: () => {
				void this.importTodayDailyNoteTasks()
			},
		})

		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (!(file instanceof TFile)) return
				if (!this.settings.dailyNotesAutoImport) return
				if (!isDailyNoteFile(file, this.settings.dailyNotesFolder)) return
				this.scheduleDailyNoteImport(file)
			}),
		)

		// Registrar la pestaña de ajustes
		this.addSettingTab(new KanbanMoonlightSettingTab(this.app, this))
	}

	onunload() {
		if (this.refreshTimer) window.clearTimeout(this.refreshTimer)
		this.dailyNoteImportTimers.forEach((timer) => window.clearTimeout(timer))
		this.dailyNoteImportTimers.clear()
		this.dailyNotePendingTasks.clear()
	}

	private scheduleDailyNoteImport(file: TFile) {
		const existingTimer = this.dailyNoteImportTimers.get(file.path)
		if (existingTimer) window.clearTimeout(existingTimer)

		const timer = window.setTimeout(() => {
			this.dailyNoteImportTimers.delete(file.path)
			void this.runAutoDailyNoteImport(file)
		}, 1500)

		this.dailyNoteImportTimers.set(file.path, timer)
	}

	async importTodayDailyNoteTasks() {
		const file = resolveDailyNoteFile(this.app, this.settings.dailyNotesFolder)
		if (!file) {
			new Notice(t('DAILY_NOTES_IMPORT_NOT_FOUND'))
			return
		}

		try {
			const count = await importTasksFromDailyNote(this.app, this, file)
			new Notice(
				count > 0
					? t('DAILY_NOTES_IMPORT_SUCCESS').replace(
							'{count}',
							String(count),
						)
					: t('DAILY_NOTES_IMPORT_NONE'),
			)
		} catch (err) {
			new Notice(t('DAILY_NOTES_IMPORT_ERROR'))
			console.error('Error importing daily note tasks:', err)
		}
	}

	/**
	 * Auto-import path: a task's text must stay unchanged between two
	 * scans before it is imported, so a task still being typed is never
	 * exported, and the title used is always the latest, settled one.
	 */
	private async runAutoDailyNoteImport(file: TFile) {
		try {
			const content = await this.app.vault.read(file)
			const candidates = extractUncheckedTaskLines(
				content,
				this.settings.dailyNotesHeading,
			)
			const previouslySeen =
				this.dailyNotePendingTasks.get(file.path) ??
				new Map<number, string>()
			const { ready, pending } = filterStableTasks(
				candidates,
				previouslySeen,
			)

			if (pending.size > 0) {
				this.dailyNotePendingTasks.set(file.path, pending)
				// Some lines are still settling: check again after a pause.
				this.scheduleDailyNoteImport(file)
			} else {
				this.dailyNotePendingTasks.delete(file.path)
			}

			if (ready.length === 0) return

			const count = await importTaskLines(this.app, this, file, ready)
			if (count > 0) {
				new Notice(
					t('DAILY_NOTES_IMPORT_SUCCESS').replace(
						'{count}',
						String(count),
					),
				)
			}
		} catch (err) {
			new Notice(t('DAILY_NOTES_IMPORT_ERROR'))
			console.error('Error importing daily note tasks:', err)
		}
	}

	// Función para abrir o enfocar la pestaña del Kanban
	async activeView() {
		const { workspace } = this.app
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_KANBAN)[0]

		if (!leaf) {
			leaf = workspace.getLeaf('tab')
			await leaf.setViewState({
				type: VIEW_TYPE_KANBAN,
				active: true,
			})
		}
		void workspace.revealLeaf(leaf)
	}

	refreshView = () => {
		if (this.refreshTimer) window.clearTimeout(this.refreshTimer)
		this.refreshTimer = window.setTimeout(() => {
			this.app.workspace
				.getLeavesOfType(VIEW_TYPE_KANBAN)
				.forEach((leaf) => {
					if (leaf.view instanceof KanbanMoonlightView) {
						leaf.view.drawCurrentView()
					}
				})
		}, 100)
	}

	async loadSettings() {
		const raw = (await this.loadData()) as Record<string, unknown> | null
		this.settings = migrateSettings(raw)
	}

	async saveSettings() {
		await this.saveData(this.settings)
		this.refreshView()
	}
}
