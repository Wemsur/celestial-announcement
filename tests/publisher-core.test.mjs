import test from 'node:test'
import assert from 'node:assert/strict'
import {
	applyIssue, auditIssue, buildIndex, parseForm, timestamp, validateDescriptor, validateState, withdraw,
} from '../scripts/publisher-core.mjs'

const at = '2026-01-01T00:00:00.000Z'
const form = (text = '历史测试正文') => `### 公告等级\n\ninfo\n\n### 生效时间\n\n2026-01-01T00:00:00+00:00\n\n### 到期时间\n\n2026-01-02T00:00:00Z\n\n### 公告正文\n\n${text}\n`
const issue = (overrides = {}) => ({ id: 123, number: 1, title: '离线测试', body: form(), state: 'open',
	updated_at: at, user: { login: 'Wemsur' }, labels: [{ name: 'announcement' }], ...overrides })
const allowed = { body: true, title: true, state: true }
const empty = () => ({ schema_version: 1, records: [] })

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

test('路径和重复标识不能覆盖文件', () => {
	const state = empty()
	applyIssue(state, issue(), allowed, at)
	assert.throws(() => validateDescriptor({ ...state.records[0].descriptor, body_path: '../README.md' }))
	assert.throws(() => validateState({ schema_version: 1, records: [state.records[0], state.records[0]] }))
})
