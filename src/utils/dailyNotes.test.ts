import { describe, it, expect } from 'vitest'
import {
	findDailyNoteSection,
	extractUncheckedTaskLines,
	sanitizeTaskTitle,
	getDailyNoteFilePath,
	isDailyNoteFile,
} from './dailyNotes'

describe('findDailyNoteSection', () => {
	it('returns the whole note when heading is empty', () => {
		const lines = ['# Day', 'line1', '## Tasks', 'line2']
		expect(findDailyNoteSection(lines, '')).toEqual({
			start: 0,
			end: lines.length,
		})
	})

	it('finds the section under a matching heading', () => {
		const lines = [
			'# Day',
			'## Tasks',
			'- [ ] a',
			'- [ ] b',
			'## Notes',
			'something else',
		]
		expect(findDailyNoteSection(lines, 'Tasks')).toEqual({
			start: 2,
			end: 4,
		})
	})

	it('is case-insensitive and ignores leading #s', () => {
		const lines = ['## tasks', '- [ ] a']
		expect(findDailyNoteSection(lines, '# Tasks')).toEqual({
			start: 1,
			end: 2,
		})
	})

	it('returns an empty range when the heading is not found', () => {
		const lines = ['# Day', '- [ ] a']
		expect(findDailyNoteSection(lines, 'Tasks')).toEqual({
			start: 0,
			end: 0,
		})
	})

	it('stops only at a heading of equal or shallower level', () => {
		const lines = [
			'## Tasks',
			'- [ ] a',
			'### Subsection',
			'- [ ] b',
			'## Next',
			'- [ ] c',
		]
		expect(findDailyNoteSection(lines, 'Tasks')).toEqual({
			start: 1,
			end: 4,
		})
	})
})

describe('extractUncheckedTaskLines', () => {
	it('extracts unchecked checkbox items', () => {
		const content = [
			'## Tasks',
			'- [ ] Buy milk',
			'- [x] Already done',
			'* [ ] Call plumber',
			'Not a task line',
		].join('\n')

		const tasks = extractUncheckedTaskLines(content, '')
		expect(tasks).toEqual([
			{ lineIndex: 1, text: 'Buy milk' },
			{ lineIndex: 3, text: 'Call plumber' },
		])
	})

	it('skips tasks already linked to an imported note', () => {
		const content = ['- [ ] [[Buy milk]]', '- [ ] New task'].join('\n')
		const tasks = extractUncheckedTaskLines(content, '')
		expect(tasks).toEqual([{ lineIndex: 1, text: 'New task' }])
	})

	it('only scans the configured heading section', () => {
		const content = [
			'## Tasks',
			'- [ ] In section',
			'## Other',
			'- [ ] Outside section',
		].join('\n')

		const tasks = extractUncheckedTaskLines(content, 'Tasks')
		expect(tasks).toEqual([{ lineIndex: 1, text: 'In section' }])
	})
})

describe('sanitizeTaskTitle', () => {
	it('strips characters not allowed in filenames', () => {
		expect(sanitizeTaskTitle('Fix: bug/issue? "urgent"')).toBe(
			'Fix- bug-issue- -urgent-',
		)
	})
})

describe('getDailyNoteFilePath', () => {
	it('builds the path from folder and date', () => {
		const date = new Date(2026, 10, 20)
		expect(getDailyNoteFilePath('Daily', date)).toBe('Daily/2026-11-20.md')
	})

	it('normalizes folder slashes', () => {
		const date = new Date(2026, 10, 20)
		expect(getDailyNoteFilePath('/Daily/', date)).toBe('Daily/2026-11-20.md')
	})

	it('defaults to the vault root when folder is empty', () => {
		const date = new Date(2026, 10, 20)
		expect(getDailyNoteFilePath('', date)).toBe('2026-11-20.md')
	})
})

describe('isDailyNoteFile', () => {
	const makeFile = (path: string, basename: string) => ({ path, basename })

	it('matches a file named with the date format inside the folder', () => {
		const file = makeFile('Daily/2026-11-20.md', '2026-11-20')
		expect(isDailyNoteFile(file, 'Daily')).toBe(true)
	})

	it('rejects files outside the configured folder', () => {
		const file = makeFile('Other/2026-11-20.md', '2026-11-20')
		expect(isDailyNoteFile(file, 'Daily')).toBe(false)
	})

	it('rejects files not matching the date pattern', () => {
		const file = makeFile('Daily/notes.md', 'notes')
		expect(isDailyNoteFile(file, 'Daily')).toBe(false)
	})
})
