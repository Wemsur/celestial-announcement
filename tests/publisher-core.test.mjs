import test from 'node:test'
import assert from 'node:assert/strict'
import { feedbackBody, postFeedback } from '../scripts/issue-feedback.mjs'
import { parseSyncFlag } from '../scripts/publish-announcements.mjs'
import {
	applyIssue, auditIssue, buildIndex, parseForm, timestamp, validateDescriptor, validateState, withdraw,
} from '../scripts/publisher-core.mjs'

const at = '2026-01-01T00:00:00.000Z'
const form = (text = '历史测试正文') => `### 公告等级\n\ninfo\n\n### 生效时间\n\n2026-01-01T00:00:00+00:00\n\n### 到期时间\n\n2026-01-02T00:00:00Z\n\n### 公告正文\n\n${text}\n`
const issue = (overrides = {}) => ({ id: 123, number: 1, title: '离线测试', body: form(), state: 'open',
	updated_at: at, user: { login: 'Wemsur' }, labels: [{ name: 'announcement' }], ...overrides })
const allowed = { body: true, title: true, state: true }
const empty = () => ({ schema_version: 1, records: [] })

test('取消 GitCode 同步不被当成缺省值，缺省仍同步', () => {
	assert.equal(parseSyncFlag(), true)
	assert.equal(parseSyncFlag('true'), true)
	assert.equal(parseSyncFlag('false'), false)
	assert.throws(() => parseSyncFlag(''), /SYNC_GITCODE 必须为 true 或 false/)
})

test('严格日期与明确时区', () => {
	assert.equal(timestamp('2026-01-01T08:00:00+08:00'), at)
	for (const value of ['2026-01-01 08:00', '2026-02-30T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:00:00+25:00']) {
		assert.throws(() => timestamp(value))
	}
})

test('表单正文中后续标题不会被当作元数据，代码缩进保留', () => {
	const parsed = parseForm(form('    code\n\n### 到期时间\n这部分是正文'), at)
	assert.ok(parsed.markdown.startsWith('    code'))
	assert.ok(parsed.markdown.includes('这部分是正文'))
	assert.throws(() => parseForm(form('世'.repeat(128 * 1024)), at))
	assert.throws(() => parseForm(form().replace('2026-01-02T00:00:00Z', '2025-01-01T00:00:00Z'), at))
})

test('同 ID 编辑保留身份和首次发布时间，无变更不增加 generation', () => {
	const state = empty()
	applyIssue(state, issue(), allowed, at)
	const first = buildIndex(state, null, at)
	assert.equal(buildIndex(state, first, '2026-01-03T00:00:00Z').generation, first.generation)
	applyIssue(state, issue({ title: '修改标题', updated_at: '2026-01-01T01:00:00Z' }), allowed, '2026-01-01T02:00:00Z')
	const next = buildIndex(state, first, '2026-01-01T02:00:00Z')
	assert.equal(next.announcements[0].id, 'github-123')
	assert.equal(next.announcements[0].published_at, at)
	assert.equal(next.generation, first.generation + 1)
})

test('不信任普通作者或未核实编辑者', () => {
	const state = empty()
	assert.equal(applyIssue(state, issue({ user: { login: 'other' } }), allowed, at), null)
	assert.equal(applyIssue(state, issue(), { ...allowed, body: false }, at), null)
	assert.deepEqual(auditIssue({ author: { login: 'Wemsur' } }), { body: false, title: false, state: false })
	assert.equal(auditIssue({ author: { login: 'Wemsur' }, editor: { login: 'other' }, lastEditedAt: at,
		titleEvents: { nodes: [] }, stateEvents: { nodes: [] } }).body, false)
})

test('关闭、重开保留正文路径，撤回不保留内容且不可复活', () => {
	const state = empty()
	applyIssue(state, issue(), allowed, at)
	const body = state.records[0].descriptor.body_path
	applyIssue(state, issue({ state: 'closed', updated_at: '2026-01-01T01:00:00Z' }), allowed, at)
	assert.equal(state.records[0].descriptor.state, 'ended')
	assert.equal(state.records[0].descriptor.body_path, body)
	applyIssue(state, issue({ updated_at: '2026-01-01T02:00:00Z' }), allowed, at)
	assert.equal(state.records[0].descriptor.state, 'published')
	withdraw(state, 'github-123', '2026-01-01T03:00:00Z')
	assert.deepEqual(Object.keys(state.records[0].descriptor).sort(), ['id', 'published_at', 'state', 'updated_at'])
	assert.ok(!JSON.stringify(state).includes('离线测试'))
	assert.equal(applyIssue(state, issue({ updated_at: '2026-01-01T04:00:00Z' }), allowed, at), null)
})

test('已关闭的坏公告不阻止新公告，已发布正文保持原样', () => {
	const state = empty()
	const warnings = []
	const closed = issue({ state: 'closed', body: form().replace('2026-01-02T00:00:00Z', '2025-01-01T00:00:00Z') })
	assert.equal(applyIssue(state, closed, allowed, at, (warning) => warnings.push(warning)), null)
	assert.equal(state.records.length, 0)
	assert.equal(warnings.length, 1)
	applyIssue(state, issue(), allowed, at)
	const original = { ...state.records[0].descriptor }
	const revision = '2026-01-01T01:00:00Z'
	applyIssue(state, { ...closed, updated_at: revision }, allowed, at)
	assert.equal(state.records[0].descriptor.state, 'ended')
	assert.equal(state.records[0].descriptor.body_sha256, original.body_sha256)
	assert.equal(state.records[0].source_updated_at, revision)
	assert.ok(validateState(state).records[0].source_fingerprint)
	applyIssue(state, { ...closed, updated_at: '2026-01-01T02:00:00Z' }, allowed, at)
	assert.equal(state.records[0].source_updated_at, '2026-01-01T02:00:00Z')
	assert.throws(() => applyIssue(empty(), { ...closed, state: 'open' }, allowed, at))
})

test('反馈标记不受评论更新 Issue 时间影响，结果变化产生新标记', () => {
	const result = { ok: true, title: '公告发布成功', message: '已同步' }
	const marker = (body) => body.split('\n')[0]
	const first = feedbackBody(issue(), result, null)
	assert.equal(marker(first), marker(feedbackBody(issue({ updated_at: '2026-01-02T00:00:00Z' }), result, null)))
	assert.notEqual(marker(first), marker(feedbackBody(issue(), { ...result, ok: false }, null)))
})

test('只将真实机器人同修订同结果评论视为去重记录', async () => {
	const result = { ok: true, title: '公告发布成功', message: '已同步' }
	const body = feedbackBody(issue(), result, null)
	let posts = 0
	const api = async (_url, _token, payload) => {
		if (payload) { posts++; return { status: 201 } }
		return { status: 200, data: [{ user: { login: 'github-actions[bot]', type: 'Bot' }, body }] }
	}
	await postFeedback(api, 'https://api.github.com/repos/example/repo', 'fake', issue(), result, null)
	assert.equal(posts, 0)
	await postFeedback(api, 'https://api.github.com/repos/example/repo', 'fake', issue(), { ...result, ok: false }, null)
	assert.equal(posts, 1)
})

test('失败之后恢复成功时不被更早的成功评论吞掉', async () => {
	const success = { ok: true, title: '公告发布成功', message: '已同步' }
	const failure = { ok: false, title: '同步未完成', message: '请重试' }
	const comments = [success, failure].map((result) => ({
		user: { login: 'github-actions[bot]', type: 'Bot' }, body: feedbackBody(issue(), result, null),
	}))
	let posts = 0
	const api = async (_url, _token, payload) => {
		if (payload) { posts++; return { status: 201 } }
		return { status: 200, data: comments }
	}
	await postFeedback(api, 'https://api.github.com/repos/example/repo', 'fake', issue(), success, null)
	assert.equal(posts, 1)
})

test('未可信的关闭操作不归档且不接受正文修订', () => {
	const state = empty()
	applyIssue(state, issue(), allowed, at)
	const original = JSON.stringify(state)
	applyIssue(state, issue({ state: 'closed', body: form('不应接纳'), updated_at: '2026-01-01T01:00:00Z' }), { ...allowed, state: false }, at)
	assert.equal(JSON.stringify(state), original)
})

test('路径和重复标识不能覆盖文件', () => {
	const state = empty()
	applyIssue(state, issue(), allowed, at)
	assert.throws(() => validateDescriptor({ ...state.records[0].descriptor, body_path: '../README.md' }))
	assert.throws(() => validateState({ schema_version: 1, records: [state.records[0], state.records[0]] }))
})
