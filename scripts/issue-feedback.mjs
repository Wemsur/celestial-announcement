import { issueFingerprint, sha256 } from './publisher-core.mjs'

/** Comments do not change this key; only announcement inputs and the result do. */
export function feedbackBody(issue, outcome, runUrl) {
	const revision = issueFingerprint(issue)
	const result = sha256(JSON.stringify(outcome))
	const marker = `<!-- celestial-announcement:${revision}:${result} -->`
	const details = String(outcome.message).slice(0, 2000).replaceAll('@', '＠').replaceAll('`', 'ˋ')
	return `${marker}\n${outcome.ok ? '✅' : '⚠️'} **${outcome.title}**\n\n${details}\n\n${runUrl ? `[查看 Actions 运行日志](${runUrl})` : '详情请查看 Actions 运行日志。'}`
}

export async function postFeedback(api, base, token, issue, outcome, runUrl) {
	const body = feedbackBody(issue, outcome, runUrl)
	const marker = body.slice(0, body.indexOf('\n'))
	const revisionPrefix = `<!-- celestial-announcement:${issueFingerprint(issue)}:`
	let latestResult = null
	for (let page = 1; page <= 100; page++) {
		const response = await api(`${base}/issues/${issue.number}/comments?per_page=100&page=${page}`, token)
		if (response.status !== 200 || !Array.isArray(response.data)) throw new Error('无法完整读取反馈评论')
		for (const comment of response.data) {
			if (comment.user?.login === 'github-actions[bot]' && comment.user?.type === 'Bot'
				&& typeof comment.body === 'string' && comment.body.startsWith(revisionPrefix)) {
				latestResult = comment.body.split('\n')[0]
			}
		}
		if (response.data.length < 100) {
			if (latestResult === marker) return
			const posted = await api(`${base}/issues/${issue.number}/comments`, token, { body })
			if (posted.status !== 201) throw new Error('反馈评论未创建')
			return
		}
	}
	throw new Error('反馈评论分页超出上限，停止评论避免重复')
}
