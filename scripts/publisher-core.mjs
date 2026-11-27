import { createHash } from 'node:crypto'

export const REPOSITORY = 'Wemsur/celestial-announcement'
export const AUTHOR = 'Wemsur'
export const MAX_BODY_BYTES = 128 * 1024
export const MAX_INDEX_BYTES = 1024 * 1024
export const MAX_RECORDS = 2000
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const trusted = (login) => typeof login === 'string' && login.toLowerCase() === AUTHOR.toLowerCase()
export const issueFingerprint = (issue) => sha256(JSON.stringify([issue.id, issue.title, issue.body, issue.state]))

export function timestamp(value) {
	if (typeof value !== 'string') throw new Error('时间必须是带时区的 RFC3339 字符串')
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value)
	if (!match) throw new Error('时间需包含秒和明确时区，例如 2026-12-01T18:00:00+08:00')
	const [, year, month, day, hour, minute, second, zone] = match
	const y = Number(year), m = Number(month), d = Number(day)
	const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
	if (y < 1970 || m < 1 || m > 12 || d < 1 || d > days || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
		|| (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) throw new Error('公告时间无效')
	const parsed = Date.parse(value)
	if (!Number.isFinite(parsed)) throw new Error('公告时间无效')
	return new Date(parsed).toISOString()
}

function issueId(issue) {
	if (!Number.isSafeInteger(issue.id) || issue.id <= 0 || !Number.isSafeInteger(issue.number) || issue.number <= 0) throw new Error('Issue 标识无效')
	return `github-${issue.id}`
}

export function validateDescriptor(raw) {
	if (!raw || !/^github-[1-9]\d{0,19}$/.test(raw.id)) throw new Error('公告 ID 无效')
	const common = { id: raw.id, published_at: timestamp(raw.published_at), updated_at: timestamp(raw.updated_at), state: raw.state }
	if (raw.state === 'withdrawn') {
		for (const key of ['title', 'level', 'issue_number', 'starts_at', 'expires_at', 'body_path', 'body_sha256']) {
			if (raw[key] !== undefined && raw[key] !== null) throw new Error('撤回记录不能保留正文或标题')
		}
		return common
	}
	if (!['published', 'ended'].includes(raw.state) || !Number.isSafeInteger(raw.issue_number) || raw.issue_number <= 0
		|| typeof raw.title !== 'string' || !raw.title.trim() || [...raw.title].length > 500
		|| !['info', 'warning', 'critical'].includes(raw.level) || !/^[a-f0-9]{64}$/.test(raw.body_sha256)
		|| raw.body_path !== `announcements/${raw.id}/${raw.body_sha256}.md`) throw new Error('公告元数据无效')
	const starts = timestamp(raw.starts_at), expires = timestamp(raw.expires_at)
	if (Date.parse(starts) >= Date.parse(expires)) throw new Error('到期时间必须晚于生效时间')
	return { id: common.id, issue_number: raw.issue_number, title: raw.title, level: raw.level,
		published_at: common.published_at, updated_at: common.updated_at, starts_at: starts, expires_at: expires,
		state: common.state, body_path: raw.body_path, body_sha256: raw.body_sha256 }
}

export function validateState(raw) {
	if (!raw || raw.schema_version !== 1 || !Array.isArray(raw.records) || raw.records.length > MAX_RECORDS) throw new Error('发布状态格式无效')
	const seen = new Set()
	const records = raw.records.map((record) => {
		const descriptor = validateDescriptor(record.descriptor)
		if (seen.has(descriptor.id)) throw new Error('发布状态中有重复 ID')
		seen.add(descriptor.id)
		if (record.source_fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(record.source_fingerprint)) throw new Error('修订指纹无效')
		return { descriptor, source_updated_at: timestamp(record.source_updated_at),
			...(record.source_fingerprint ? { source_fingerprint: record.source_fingerprint } : {}) }
	})
	return { schema_version: 1, records }
}

export function validateIndex(raw) {
	if (!raw || raw.schema_version !== 1 || !Number.isSafeInteger(raw.generation) || raw.generation < 1
		|| !Array.isArray(raw.announcements) || raw.announcements.length > MAX_RECORDS) throw new Error('索引格式无效')
	const seen = new Set()
	const announcements = raw.announcements.map((item) => {
		const descriptor = validateDescriptor(item)
		if (seen.has(descriptor.id)) throw new Error('索引中有重复 ID')
		seen.add(descriptor.id)
		return descriptor
	})
	return { schema_version: 1, generation: raw.generation, generated_at: timestamp(raw.generated_at), announcements }
}

export function parseForm(body, defaultStart) {
	if (typeof body !== 'string') throw new Error('请使用公告 Issue 表单')
	body = body.replaceAll('\r\n', '\n')
	const marker = /^### 公告正文[ \t]*$/m.exec(body)
	if (!marker) throw new Error('缺少公告正文，请使用公告 Issue 表单')
	const prefix = body.slice(0, marker.index)
	const headings = [...prefix.matchAll(/^### ([^\n]+)$/gm)]
	const fields = new Map()
	const allowed = new Set(['公告等级', '生效时间', '到期时间'])
	for (let i = 0; i < headings.length; i++) {
		const name = headings[i][1].trim()
		if (!allowed.has(name) || fields.has(name)) throw new Error('公告表单字段重复或未知')
		const value = prefix.slice(headings[i].index + headings[i][0].length, headings[i + 1]?.index ?? prefix.length).trim()
		fields.set(name, value === '_No response_' ? '' : value)
	}
	if (fields.size !== 3) throw new Error('请完整使用公告表单')
	const level = fields.get('公告等级') || 'info'
	if (!['info', 'warning', 'critical'].includes(level)) throw new Error('公告等级必须为 info/warning/critical')
	const starts = timestamp(fields.get('生效时间') || defaultStart)
	const expires = timestamp(fields.get('到期时间'))
	if (Date.parse(starts) >= Date.parse(expires)) throw new Error('到期时间必须晚于生效时间')
	const markdown = body.slice(marker.index + marker[0].length).replace(/^\n+|\n+$/g, '') + '\n'
	if (!markdown.trim()) throw new Error('公告正文不能为空')
	if (Buffer.byteLength(markdown) > MAX_BODY_BYTES) throw new Error('正文超过 128 KiB，请缩短公告')
	return { level, starts_at: starts, expires_at: expires, markdown }
}

/** Audit comes from GitHub, not from Issue text or author_association. */
export function auditIssue(node) {
	if (!node || !trusted(node.author?.login) || !Object.hasOwn(node, 'editor') || !Object.hasOwn(node, 'lastEditedAt')
		|| !Array.isArray(node.titleEvents?.nodes) || !Array.isArray(node.stateEvents?.nodes)) return { body: false, title: false, state: false }
	const rename = node.titleEvents?.nodes?.[0]
	const control = node.stateEvents?.nodes?.[0]
	return {
		body: !node.lastEditedAt ? node.editor == null || trusted(node.editor?.login) : trusted(node.editor?.login),
		title: !rename || trusted(rename.actor?.login),
		state: !control || trusted(control.actor?.login),
	}
}

function applyControl(previous, issue, audit, revision) {
	if (!previous || !audit.state || !['open', 'closed'].includes(issue.state)) return
	const state = issue.state === 'closed' ? 'ended' : 'published'
	if (previous.descriptor.state !== state) {
		previous.descriptor = { ...previous.descriptor, state, updated_at: revision }
		previous.source_updated_at = revision
	}
}

/** Updates use the latest audited source, so collapsed Actions events do not lose changes. */
export function applyIssue(state, issue, audit, now, onWarning = () => {}) {
	const id = issueId(issue)
	const previous = state.records.find((record) => record.descriptor.id === id)
	if (!trusted(issue.user?.login) || issue.pull_request || previous?.descriptor.state === 'withdrawn') return null
	if (!previous && !(issue.labels ?? []).some((label) => (typeof label === 'string' ? label : label.name) === 'announcement')) return null
	const revision = timestamp(issue.updated_at)
	if (previous && Date.parse(revision) < Date.parse(previous.source_updated_at)) return null
	if (previous && issue.state === 'closed' && audit.state) {
		applyControl(previous, issue, audit, revision)
		previous.source_updated_at = revision
		previous.source_fingerprint = issueFingerprint(issue)
		return null
	}
	if (!audit.body || !audit.title || !audit.state) {
		applyControl(previous, issue, audit, revision)
		return null
	}
	const published = previous?.descriptor.published_at ?? timestamp(now)
	let form
	try { form = parseForm(issue.body, published) }
	catch (error) {
		applyControl(previous, issue, audit, revision)
		if (issue.state === 'closed' && audit.state) {
			onWarning(`已关闭且未成功发布的公告已跳过：${error.message}`)
			return null
		}
		throw error
	}
	const title = typeof issue.title === 'string' ? issue.title.trim() : ''
	const hash = sha256(Buffer.from(form.markdown))
	const status = audit.state ? (issue.state === 'closed' ? 'ended' : 'published') : previous?.descriptor.state
	if (!status) return null
	let descriptor
	try {
		descriptor = validateDescriptor({ id, issue_number: issue.number, title, level: form.level,
			published_at: published, updated_at: revision, starts_at: form.starts_at, expires_at: form.expires_at,
			state: status, body_path: `announcements/${id}/${hash}.md`, body_sha256: hash })
	} catch (error) {
		if (issue.state === 'closed' && audit.state) {
			onWarning(`已关闭且未成功发布的公告已跳过：${error.message}`)
			return null
		}
		throw error
	}
	if (previous) {
		const comparable = (item) => JSON.stringify({ ...item, updated_at: '' })
		if (comparable(previous.descriptor) === comparable(descriptor)) {
			previous.source_fingerprint = issueFingerprint(issue)
			return null
		}
		previous.descriptor = descriptor
		previous.source_updated_at = revision
		previous.source_fingerprint = issueFingerprint(issue)
	} else {
		if (state.records.length >= MAX_RECORDS) throw new Error('公告超过 2000 条，需要升级归档协议，不能截断历史')
		state.records.push({ descriptor, source_updated_at: revision, source_fingerprint: issueFingerprint(issue) })
	}
	return { path: descriptor.body_path, markdown: form.markdown }
}

export function withdraw(state, id, now) {
	const record = state.records.find((item) => item.descriptor.id === id)
	if (!record || record.descriptor.state === 'withdrawn') return false
	const at = timestamp(now)
	record.descriptor = { id, published_at: record.descriptor.published_at, updated_at: at, state: 'withdrawn' }
	record.source_updated_at = at
	delete record.source_fingerprint
	return true
}

export function buildIndex(state, previous, now) {
	validateState(state)
	const announcements = state.records.map((record) => validateDescriptor(record.descriptor)).sort((a, b) =>
		Date.parse(b.published_at) - Date.parse(a.published_at) || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0))
	const same = previous && JSON.stringify(previous.announcements) === JSON.stringify(announcements)
	const generation = same ? previous.generation : (previous?.generation ?? 0) + 1
	if (!Number.isSafeInteger(generation)) throw new Error('公告 generation 超出范围')
	const index = { schema_version: 1, generation, generated_at: same ? previous.generated_at : timestamp(now), announcements }
	if (Buffer.byteLength(JSON.stringify(index, null, '\t') + '\n') > MAX_INDEX_BYTES) throw new Error('索引超过 1 MiB，不能截断历史')
	return index
}
