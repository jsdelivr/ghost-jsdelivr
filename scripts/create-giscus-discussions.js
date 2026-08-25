const { createHash } = require('node:crypto');

const SITE_URL = 'https://www.jsdelivr.com/blog/';
const API_URL = 'https://www.jsdelivr.com/blog/ghost/api/content/posts/';
const REPOSITORY_OWNER = 'jsdelivr';
const REPOSITORY_NAME = 'ghost-jsdelivr';
const REPOSITORY_ID = 'MDEwOlJlcG9zaXRvcnkxMDMyOTk5MDc=';
const CATEGORY_ID = 'DIC_kwDOBig7Q84DDP0W';
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

const fetchResponse = async (url, type) => {
	const response = await fetch(url, {
		headers: {
			'User-Agent': 'jsdelivr-giscus-discussion-action',
		},
		signal: AbortSignal.timeout(30_000),
	});

	if (!response.ok) {
		throw new Error(`${type} request failed with HTTP ${response.status}: ${url}`);
	}

	return response;
};

const getRecentPosts = async () => {
	const homepageResponse = await fetchResponse(SITE_URL, 'Homepage');
	const homepage = await homepageResponse.text();
	const contentKey = homepage.match(/<script\b[^>]*\bdata-key=["']([a-f0-9]+)["']/i)?.[1];

	if (!contentKey) {
		throw new Error('The public Ghost Content API key was not found on the live homepage.');
	}

	const url = new URL(API_URL);
	url.searchParams.set('key', contentKey);
	url.searchParams.set('limit', '100');
	url.searchParams.set('fields', 'title,url,comment_id,published_at,excerpt');
	url.searchParams.set('order', 'published_at DESC');

	const postsResponse = await fetchResponse(url, 'Content API');
	const payload = await postsResponse.json();

	if (!Array.isArray(payload.posts)) {
		throw new Error('The live Content API returned an unexpected response shape.');
	}

	return payload.posts;
};

const validatePost = (post) => {
	const title = typeof post.title === 'string' ? post.title.replace(/\s+/g, ' ').trim() : '';

	if (!title || title.length > 256) {
		throw new Error(`Post ${post.comment_id ?? 'unknown'} has an invalid title.`);
	}

	if (typeof post.comment_id !== 'string'
		|| !post.comment_id
		|| post.comment_id.trim() !== post.comment_id
		|| /[\s\p{Cc}]/u.test(post.comment_id)) {
		throw new Error(`Post "${title}" does not have a comment ID.`);
	}

	const postUrl = new URL(post.url);

	if (postUrl.protocol !== 'https:'
		|| postUrl.hostname !== 'www.jsdelivr.com'
		|| postUrl.port !== ''
		|| postUrl.username !== ''
		|| postUrl.password !== ''
		|| postUrl.search !== ''
		|| postUrl.hash !== ''
		|| postUrl.pathname.includes('//')
		|| post.url !== postUrl.href
		|| !postUrl.pathname.startsWith('/blog/')) {
		throw new Error(`Post "${title}" has an unexpected public URL: ${postUrl}`);
	}

	return { commentId: post.comment_id, title, postUrl };
};

module.exports = async ({ github, core }) => {
	const posts = await getRecentPosts();
	const now = Date.now();
	const cutoff = now - LOOKBACK_MS;
	const recentPosts = [];
	let hasFailures = false;
	const reportPostFailure = (post, error) => {
		hasFailures = true;
		const postTitle = typeof post?.title === 'string'
			? post.title.replace(/\s+/g, ' ').trim()
			: '';
		const postId = typeof post?.comment_id === 'string' ? post.comment_id : '';
		const postLabel = postTitle || postId || 'unknown post';
		core.error(`Unable to process "${postLabel}": ${error instanceof Error ? error.message : error}.`);
	};

	for (const post of posts) {
		try {
			if (!post || typeof post !== 'object' || Array.isArray(post)) {
				throw new Error('The Content API returned an invalid post entry.');
			}

			const publishedAtMatch = typeof post.published_at === 'string'
				? post.published_at.match(/^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/)
				: null;
			const publishedAt = Date.parse(post.published_at);
			const year = Number(publishedAtMatch?.[1]);
			const month = Number(publishedAtMatch?.[2]);
			const day = Number(publishedAtMatch?.[3]);
			const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

			if (!publishedAtMatch
				|| !Number.isFinite(publishedAt)
				|| month < 1
				|| month > 12
				|| day < 1
				|| day > daysInMonth) {
				throw new Error('The post has an invalid publication date.');
			}

			if (publishedAt < cutoff) {
				continue;
			}

			if (publishedAt > now) {
				continue;
			}

			recentPosts.push({ post, ...validatePost(post) });
		} catch (error) {
			reportPostFailure(post, error);
		}
	}

	if (!recentPosts.length) {
		if (hasFailures) {
			core.setFailed('Unable to process one or more recent posts.');
		} else {
			core.info('No posts were published in the past 24 hours.');
		}

		return;
	}

	const discussionsByHash = new Map();
	const seenCursors = new Set();
	let cursor;

	do {
		const result = await github.graphql(
			`query($owner: String!, $name: String!, $categoryId: ID!, $cursor: String) {
				repository(owner: $owner, name: $name) {
				discussions(first: 100, after: $cursor, categoryId: $categoryId, orderBy: { field: CREATED_AT, direction: ASC }) {
						nodes {
							body
							url
						}
						pageInfo {
							endCursor
							hasNextPage
						}
					}
				}
			}`,
			{
				categoryId: CATEGORY_ID,
				cursor,
				name: REPOSITORY_NAME,
				owner: REPOSITORY_OWNER,
			},
		);
		const discussions = result.repository.discussions;

		if (!Array.isArray(discussions?.nodes)
			|| typeof discussions?.pageInfo?.hasNextPage !== 'boolean') {
			throw new Error('GitHub returned an unexpected discussions response shape.');
		}

		for (const discussion of discussions.nodes) {
			if (!discussion) {
				continue;
			}

			for (const match of discussion.body.matchAll(/[a-f0-9]{40}/gi)) {
				discussionsByHash.set(match[0].toLowerCase(), discussion.url);
			}
		}

		if (discussions.pageInfo.hasNextPage) {
			const nextCursor = discussions.pageInfo.endCursor;

			if (typeof nextCursor !== 'string' || !nextCursor || seenCursors.has(nextCursor)) {
				throw new Error('GitHub returned an invalid discussions pagination cursor.');
			}

			seenCursors.add(nextCursor);
			cursor = nextCursor;
		} else {
			cursor = undefined;
		}
	} while (cursor);

	for (const { commentId, post, postUrl, title } of recentPosts) {
		try {
			const term = `jsdelivr-post-${commentId}`;
			const hash = createHash('sha1').update(term).digest('hex');
			const existingUrl = discussionsByHash.get(hash);

			if (discussionsByHash.has(hash)) {
				const reason = existingUrl
					? `its discussion already exists at ${existingUrl}`
					: 'its mapping was already attempted earlier in this run';

				core.info(`Skipping "${title}"; ${reason}.`);
				continue;
			}

			const excerpt = post.excerpt?.trim();
			const bodyParts = [`# ${title}`];

			if (excerpt) {
				bodyParts.push(excerpt);
			}

			bodyParts.push(
				postUrl.href,
				'<!-- created-by: create-giscus-discussions -->',
				`<!-- sha1: ${hash} -->`,
			);
			discussionsByHash.set(hash, null);

			const created = await github.graphql(
				`mutation($input: CreateDiscussionInput!) {
					createDiscussion(input: $input) {
						discussion {
							url
						}
					}
				}`,
				{
					input: {
						body: bodyParts.join('\n\n'),
						categoryId: CATEGORY_ID,
						repositoryId: REPOSITORY_ID,
						title,
					},
				},
			);
			const createdUrl = created.createDiscussion.discussion.url;

			if (typeof createdUrl !== 'string'
				|| !/^https:\/\/github\.com\/jsdelivr\/ghost-jsdelivr\/discussions\/\d+$/.test(createdUrl)) {
				throw new Error('GitHub returned an invalid created discussion URL.');
			}

			discussionsByHash.set(hash, createdUrl);
			core.info(`Created the discussion for "${title}" at ${createdUrl}.`);
		} catch (error) {
			reportPostFailure(post, error);
		}
	}

	if (hasFailures) {
		core.setFailed('Unable to process one or more recent posts.');
	}
};
