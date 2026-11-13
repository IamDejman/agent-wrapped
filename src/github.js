import { execFile } from 'node:child_process';

const QUERY = `query($from: DateTime!, $to: DateTime!) {
  viewer {
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      totalIssueContributions
      totalRepositoriesWithContributedCommits
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

/**
 * The signed-in user's contributions for one year, asked through the GitHub
 * CLI. The CLI holds the login; this code never sees or stores a token.
 */
export function fetchContributions(year) {
  const args = ['api', 'graphql', '-f', `query=${QUERY}`, '-f', `from=${year}-01-01T00:00:00Z`, '-f', `to=${year}-12-31T23:59:59Z`];
  return new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: 20_000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err?.code === 'ENOENT') return reject(new Error('the GitHub CLI (gh) is not installed. Get it from https://cli.github.com, then run: gh auth login'));
      if (err) return reject(new Error(stderr.trim().split('\n')[0] || err.message));
      try {
        const collection = JSON.parse(stdout).data?.viewer?.contributionsCollection;
        if (!collection) throw new Error('GitHub sent no contributions');
        resolve(collection);
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Turns GitHub's answer into the few numbers the wrap shows. `aiDays` is the wrap's days map. */
export function summarise(collection, aiDays = {}) {
  const days = collection.contributionCalendar.weeks.flatMap((w) => w.contributionDays).filter((d) => d.contributionCount > 0);
  const busiest = days.reduce((best, d) => (d.contributionCount > (best?.contributionCount ?? 0) ? d : best), null);
  return {
    total: collection.contributionCalendar.totalContributions,
    commits: collection.totalCommitContributions,
    prs: collection.totalPullRequestContributions,
    reviews: collection.totalPullRequestReviewContributions,
    issues: collection.totalIssueContributions,
    repos: collection.totalRepositoriesWithContributedCommits,
    activeDays: days.length,
    busiest: busiest ? { date: busiest.date, count: busiest.contributionCount } : null,
    withAi: days.filter((d) => aiDays[d.date]).length, // days with both a contribution and a prompt
  };
}

export const githubYear = async (data) => summarise(await fetchContributions(data.year), data.days);
