import { spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
	AUTHOR, REPOSITORY, MAX_BODY_BYTES, MAX_INDEX_BYTES, MAX_RECORDS,
	applyIssue, auditIssue, buildIndex, sha256, trusted, validateIndex, validateState, withdraw,
} from './publisher-core.mjs'

const GITHUB = `https://github.com/${REPOSITORY}.git`
const WEMGIT = 'https://download.celestial.byside.top/celestial/celestial-announcement.git'
const API = `https://api.github.com/repos/${REPOSITORY}`
const DATA_README = '# Celestial 公告\n\n此分支由 GitHub Actions 自动生成，请勿直接编辑。\n\n在 https://github.com/Wemsur/celestial-announcement/issues 发布公告。\n\n索引：index.json；正文：announcements/。过期/结束正文保留，撤回正文不再提供。\n'
const enc = new TextDecoder('utf-8', { fatal: true })

async function exists(file) {
	try { return await lstat(file) }
	catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

async function readBounded(file, limit) {
	const stat = await lstat(file)
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('拒绝读取非普通文件')
	const handle = await open(file, 'r')
	try {
		const chunks = []
		let size = 0
		for (;;) {
			const chunk = Buffer.alloc(64 * 1024)
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
			if (!bytesRead) break
			size += bytesRead
			if (size > limit) throw new Error('文件超过安全大小上限')
			chunks.push(chunk.subarray(0, bytesRead))
		}
		return Buffer.concat(chunks)
	} finally { await handle.close() }
}

async function ensureParent(root, relative) {
	if (!/^(index\.json|publisher-state\.json|README\.md|announcements\/github-[1-9]\d{0,19}\/[a-f0-9]{64}\.md)$/.test(relative)) throw new Error('产物路径无效')
	let current = root
	const segments = relative.split('/')
	for (const segment of segments.slice(0, -1)) {
		current = path.join(current, segment)
		const stat = await exists(current)
		if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('产物目录不能为链接或特殊文件')
		if (!stat) await mkdir(current)
	}
	const target = path.join(root, ...segments)
	const stat = await exists(target)
	if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('产物文件不能为链接或特殊文件')
	return target
}

async function atomicWrite(root, relative, text) {
	const target = await ensureParent(root, relative)
	const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
	try {
		await writeFile(temporary, text, { flag: 'wx' })
		await rename(temporary, target)
	} finally { await rm(temporary, { force: true }) }
}

async function validateTree(root, relative = '') {
	for (const name of await readdir(path.join(root, relative))) {
		if (!relative && name === '.git') continue
		const rel = relative ? `${relative}/${name}` : name
		const stat = await lstat(path.join(root, rel))
		if (stat.isSymbolicLink()) throw new Error('发布分支不能包含符号链接')
		if (stat.isDirectory()) {
			if (rel !== 'announcements' && !/^announcements\/github-[1-9]\d{0,19}$/.test(rel)) throw new Error(`发布分支包含未知目录：${rel}`)
			await validateTree(root, rel)
		} else if (!stat.isFile() || !/^(index\.json|publisher-state\.json|README\.md|announcements\/github-[1-9]\d{0,19}\/[a-f0-9]{64}\.md)$/.test(rel)) {
			throw new Error(`发布分支包含未知文件：${rel}`)
		}
	}
}

async function writeSnapshot(root, state, previous, changes, now) {
	const index = buildIndex(state, previous, now)
	for (const change of changes.values()) {
		const target = await ensureParent(root, change.path)
		if (await exists(target)) {
			if (sha256(await readBounded(target, MAX_BODY_BYTES)) !== sha256(Buffer.from(change.markdown))) throw new Error('已存在正文的内容与路径摘要不符')
		} else await writeFile(target, change.markdown, { flag: 'wx' })
	}
	for (const record of state.records) {
		const item = record.descriptor
		if (item.state === 'withdrawn') {
			const directory = path.join(root, 'announcements', item.id)
			const stat = await exists(directory)
			if (stat) {
				if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('撤回目录不是普通目录')
				for (const name of await readdir(directory)) {
					const file = await ensureParent(root, `announcements/${item.id}/${name}`)
					await rm(file)
				}
				await rmdir(directory)
			}
		} else {
			const file = await ensureParent(root, item.body_path)
			if (sha256(await readBounded(file, MAX_BODY_BYTES)) !== item.body_sha256) throw new Error('正文摘要验证失败')
		}
	}
	await atomicWrite(root, 'index.json', JSON.stringify(index, null, '\t') + '\n')
	await atomicWrite(root, 'publisher-state.json', JSON.stringify(state, null, '\t') + '\n')
	await atomicWrite(root, 'README.md', DATA_README)
	return index
}

async function api(url, token, body) {
	const response = await fetch(url, {
		method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
		headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Celestial-Announcement-Publisher',
			'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	})
	if (response.status === 404) return { status: 404, data: null }
	if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`)
	let size = 0
	const chunks = []
	for await (const chunk of response.body) {
		size += chunk.length
		if (size > 16 * 1024 * 1024) throw new Error('GitHub API 响应过大')
		chunks.push(chunk)
	}
	return { status: response.status, data: JSON.parse(enc.decode(Buffer.concat(chunks))) }
}

async function listIssues(token) {
	const repo = await api(API, token)
	if (repo.status !== 200 || repo.data.full_name?.toLowerCase() !== REPOSITORY.toLowerCase()) throw new Error('无法确认公告源仓库身份')
	const issues = []
	for (let page = 1; page <= 100; page++) {
		const response = await api(`${API}/issues?state=all&creator=${AUTHOR}&per_page=100&page=${page}`, token)
		if (response.status !== 200 || !Array.isArray(response.data) || response.data.length > 100) throw new Error('Issue 列表不完整')
		issues.push(...response.data.filter((issue) => !issue.pull_request))
		if (response.data.length < 100) return issues
	}
	throw new Error('Issue 列表分页超过上限，不能把未读取部分当成删除')
}

async function auditsFor(issues, token) {
	const result = new Map()
	const query = `query($ids:[ID!]!) { nodes(ids:$ids) { ... on Issue {
		id number repository { nameWithOwner } title body state updatedAt author { login } editor { login } lastEditedAt
		titleEvents: timelineItems(last:1,itemTypes:[RENAMED_TITLE_EVENT]) { nodes { ... on RenamedTitleEvent { actor { login } } } }
		stateEvents: timelineItems(last:1,itemTypes:[CLOSED_EVENT,REOPENED_EVENT]) { nodes {
			... on ClosedEvent { actor { login } } ... on ReopenedEvent { actor { login } }
		} }
	} } }`
	for (let offset = 0; offset < issues.length; offset += 50) {
		const batch = issues.slice(offset, offset + 50)
		const response = await api('https://api.github.com/graphql', token, { query, variables: { ids: batch.map((issue) => issue.node_id) } })
		if (response.status !== 200 || response.data.errors?.length || !Array.isArray(response.data.data?.nodes)
			|| response.data.data.nodes.length !== batch.length) throw new Error('无法验证公告编辑操作者')
		response.data.data.nodes.forEach((node, index) => {
			if (!node || node.number !== batch[index].number || node.repository?.nameWithOwner?.toLowerCase() !== REPOSITORY.toLowerCase()
				|| !Object.hasOwn(node, 'editor') || !Object.hasOwn(node, 'lastEditedAt')
				|| !Array.isArray(node.titleEvents?.nodes) || !Array.isArray(node.stateEvents?.nodes)) throw new Error('公告操作者验证数据不完整')
			if (node.title !== batch[index].title || node.body !== batch[index].body || node.updatedAt !== batch[index].updated_at
				|| node.state?.toLowerCase() !== batch[index].state) throw new Error('公告在校验期间被修改，请重跑，不能混用不同修订的操作者和正文')
			result.set(batch[index].id, auditIssue(node))
		})
	}
	return result
}

function redacted(text) {
	for (const secret of [process.env.GITHUB_TOKEN, process.env.WEMGIT_TOKEN,
		process.env.WEMGIT_TOKEN && Buffer.from(`${process.env.WEMGIT_USERNAME}:${process.env.WEMGIT_TOKEN}`).toString('base64')].filter(Boolean)) {
		text = text.split(secret).join('[redacted]')
	}
	return text
}

function git(args, cwd, askpass, username, token, allowed = [0]) {
	const result = spawnSync('git', ['-c', 'http.followRedirects=false', ...args], {
		cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
		env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_TRACE: '0', GIT_TRACE_CURL: '0', GIT_CURL_VERBOSE: '0',
			GIT_ASKPASS: askpass, CELESTIAL_GIT_USER: username, CELESTIAL_GIT_TOKEN: token },
	})
	if (result.error || !allowed.includes(result.status)) throw new Error(redacted(result.stderr || result.error?.message || 'Git 操作失败'))
	return { stdout: result.stdout, status: result.status }
}

async function main() {
	if (process.argv[2] === '--bootstrap') {
		const root = path.resolve(process.argv[3] || '')
		if (!process.argv[3]) throw new Error('请指定新建的空输出目录')
		await mkdir(root, { recursive: true })
		if ((await readdir(root)).length) throw new Error('初始化只接受空目录，不能覆盖已有数据')
		await writeSnapshot(root, { schema_version: 1, records: [] }, null, new Map(), new Date().toISOString())
		console.log('已生成空发布产物，没有有效公告。')
		return
	}
	const eventName = process.env.GITHUB_EVENT_NAME
	if (!['issues', 'schedule', 'workflow_dispatch'].includes(eventName)) throw new Error('不支持的发布触发方式')
	if (process.env.GITHUB_REPOSITORY?.toLowerCase() !== REPOSITORY.toLowerCase()) throw new Error('源仓库身份不符')
	const event = JSON.parse(enc.decode(await readBounded(process.env.GITHUB_EVENT_PATH, 2 * 1024 * 1024)))
	if (eventName === 'issues' && (!trusted(process.env.GITHUB_ACTOR) || !trusted(event.sender?.login) || !trusted(event.issue?.user?.login))) {
		console.log('忽略非可信作者/编辑者的 Issue 事件。')
		return
	}
	if (eventName === 'workflow_dispatch' && !trusted(process.env.GITHUB_ACTOR)) throw new Error('仅 Wemsur 可以手动恢复发布')
	const token = process.env.GITHUB_TOKEN
	const wemToken = process.env.WEMGIT_TOKEN
	const wemUser = process.env.WEMGIT_USERNAME
	if (!token || !wemToken || !wemUser) throw new Error('请先配置 WEMGIT_USERNAME、WEMGIT_TOKEN 及 Actions 写权限；没有发布任何公告。')
	const temporary = await mkdtemp(path.join(tmpdir(), 'celestial-announcements-'))
	try {
		const askpass = path.join(temporary, 'askpass.sh')
		await writeFile(askpass, '#!/bin/sh\ncase "$1" in\n*Username*) printf \'%s\\n\' "$CELESTIAL_GIT_USER";;\n*Password*) printf \'%s\\n\' "$CELESTIAL_GIT_TOKEN";;\n*) exit 1;;\nesac\n', { mode: 0o700 })
		const root = path.join(temporary, 'data')
		const branch = git(['ls-remote', '--heads', GITHUB, 'refs/heads/published'], temporary, askpass, 'x-access-token', token).stdout.trim()
		if (branch) git(['clone', '--single-branch', '--branch', 'published', GITHUB, root], temporary, askpass, 'x-access-token', token)
		else {
			await mkdir(root)
			git(['init', '--initial-branch=published'], root, askpass, 'x-access-token', token)
			git(['remote', 'add', 'origin', GITHUB], root, askpass, 'x-access-token', token)
		}
		git(['config', 'core.autocrlf', 'false'], root, askpass, 'x-access-token', token)
		await validateTree(root)
		const hasIndex = await exists(path.join(root, 'index.json'))
		const hasState = await exists(path.join(root, 'publisher-state.json'))
		if (Boolean(hasIndex) !== Boolean(hasState) || (branch && !hasIndex)) throw new Error('发布分支缺少完整的索引/状态，请勿手工覆盖产物')
		const previous = hasIndex ? validateIndex(JSON.parse(enc.decode(await readBounded(path.join(root, 'index.json'), MAX_INDEX_BYTES)))) : null
		const state = hasState ? validateState(JSON.parse(enc.decode(await readBounded(path.join(root, 'publisher-state.json'), 4 * 1024 * 1024)))) : { schema_version: 1, records: [] }
		const now = new Date().toISOString()
		if (previous && JSON.stringify(buildIndex(state, null, now).announcements) !== JSON.stringify(previous.announcements)) {
			throw new Error('已发布索引与接受状态不一致，不能覆盖历史')
		}
		const deletedId = eventName === 'issues' && event.action === 'deleted' && Number.isSafeInteger(event.issue?.id)
			? `github-${event.issue.id}` : null
		if (deletedId) withdraw(state, deletedId, now)
		const changes = new Map()
		const errors = []
		const issues = await listIssues(token)
		const nodes = issues.filter((issue) => {
			const old = state.records.find((record) => record.descriptor.id === `github-${issue.id}`)
			return `github-${issue.id}` !== deletedId && old?.descriptor.state !== 'withdrawn'
				&& (!old || Date.parse(issue.updated_at) > Date.parse(old.source_updated_at))
		})
		const audits = await auditsFor(nodes, token)
		for (const issue of nodes) {
			try {
				const change = applyIssue(state, issue, audits.get(issue.id) ?? { body: false, title: false, state: false }, now)
				if (change) changes.set(change.path, change)
			} catch (error) { errors.push(`Issue ${issue.number}: ${error.message}`) }
		}
		const present = new Set(issues.map((issue) => `github-${issue.id}`))
		for (const record of state.records) {
			if (record.descriptor.state === 'withdrawn' || present.has(record.descriptor.id)) continue
			const check = await api(`${API}/issues/${record.descriptor.issue_number}`, token)
			if (check.status === 404) withdraw(state, record.descriptor.id, now)
		}
		const index = await writeSnapshot(root, state, previous, changes, now)
		git(['config', 'user.name', 'github-actions[bot]'], root, askpass, 'x-access-token', token)
		git(['config', 'user.email', '41998282+github-actions[bot]@users.noreply.github.com'], root, askpass, 'x-access-token', token)
		git(['add', '--all'], root, askpass, 'x-access-token', token)
		if (git(['diff', '--cached', '--quiet'], root, askpass, 'x-access-token', token, [0, 1]).status === 1) {
			git(['commit', '-m', 'docs: publish announcement snapshot'], root, askpass, 'x-access-token', token)
			git(['push', 'origin', 'HEAD:refs/heads/published'], root, askpass, 'x-access-token', token)
		}
		git(['remote', 'add', 'wemgit', WEMGIT], root, askpass, wemUser, wemToken)
		git(['push', 'wemgit', 'HEAD:refs/heads/main'], root, askpass, wemUser, wemToken)
		console.log(`已同步 generation ${index.generation}，${index.announcements.length} 条公告/历史记录。`)
		if (errors.length) throw new Error(`其他合法变更已同步，以下修订未发布，旧版本保留：\n${errors.join('\n')}`)
	} finally { await rm(temporary, { recursive: true, force: true }) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(redacted(error.message)); process.exitCode = 1 })
}
