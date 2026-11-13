# ai-wrapped-year

Your year with AI coding tools, as a story you can share. It reads the logs those tools already keep on your machine, so there is nothing to sign in to and nothing to upload.

```bash
npx ai-wrapped-year
```

Needs Node 22.13 or newer. No dependencies.

With pnpm or Bun:

```bash
pnpm dlx ai-wrapped-year
bunx --bun ai-wrapped-year
```

The Bun command runs on Bun alone, without Node.

No Node? On a Mac or Linux, Homebrew installs it for you:

```bash
brew install iamdejman/tap/ai-wrapped-year
ai-wrapped-year
```

See a demo wrap at [aiyearwrapped.com](https://aiyearwrapped.com/).

## What you get

A page of slides, like a music app's year in review: prompts, tokens, hours, your longest streak, busiest day, top projects, models, what it would have cost at list prices, what caching saved, and a persona. The last slide saves a 1080x1920 image for sharing.

## Tools it reads

| Tool | Status |
| --- | --- |
| Claude Code | Checked against real logs |
| Codex | Checked against real logs |
| Cursor | Checked against real logs |
| Antigravity | Checked against real logs |
| Grok | Checked against real logs |
| Copilot Chat (VS Code) | Checked against a small sample |
| Amp | Checked against a small sample |
| Gemini CLI | Written from the documented format, tested on fixtures only |
| opencode | Written from the documented format, tested on fixtures only |

Kimi Code, Windsurf, Cline, Roo Code, Continue, Goose, Qwen Code, Factory Droid and Zed are detected and reported, but not read yet. Run `npx ai-wrapped-year --doctor` to see what was found for each tool. For tools not read yet it prints the layout of their files (field names only, never contents), which is what a new reader needs. Paste that into an issue.

Models are counted under the tool that called them. DeepSeek, Kimi or any other model used inside one of the tools above shows up there.

## API keys and missing months

Using an API key inside one of the tools above changes nothing: the logs are the same.

Calls made from your own code leave no local logs. Download the usage export (CSV) from your provider's console and add it:

```bash
npx ai-wrapped-year --usage usage.csv
```

Cursor keeps token counts on its servers, not on disk. Add the export from its dashboard:

```bash
npx ai-wrapped-year --cursor-csv cursor-usage.csv
```

Most tools delete old chats. Every run copies what it reads into `~/.agent-wrapped/archive`, so months you have already wrapped stay in your year after the tool removes them. Anything deleted before your first run is gone, so run it early.

## More than one profile or account

Every profile on the machine is read, however it was made, and a chat that sits in two of them counts once. The run says which profiles it read.

| How the profile was made | Example |
| --- | --- |
| A folder beside the default one | `~/.claude-work` next to `~/.claude`. The same for Codex, Grok, Gemini CLI and Antigravity |
| A variable | `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME` or `GEMINI_CLI_HOME`, set when you run this. Each takes a comma-separated list |
| An alias or wrapper script | `alias claude-work='CLAUDE_CONFIG_DIR=~/clients/acme claude'` in a shell startup file, or a script in `~/bin` or `~/.local/bin` |
| An account switcher | Folders such as `~/.ccs/instances/work` or `~/.claude-profiles/work` (Claude Code and Codex) |
| A profile inside an editor | Each profile made in Cursor or VS Code |
| A second copy of an editor | Cursor Nightly, VS Code Insiders, or one started with `--user-data-dir` from an alias or launcher |
| The Claude desktop app | Sessions the app runs itself are counted under Claude Code |

Switching accounts inside one folder (signing out and in again) needs nothing: the history stays in the same place.

Not found: history under another user account on the computer, inside a container or WSL, or in a folder that nothing on the machine points to. For a folder, name it once: `CLAUDE_CONFIG_DIR=/path/to/folder npx ai-wrapped-year`. For the rest, use `--export` there and `--import` here.

## More than one machine

```bash
npx ai-wrapped-year --export laptop.gz     # on the other machine
npx ai-wrapped-year --import laptop.gz     # on this one
```

## GitHub

```bash
npx ai-wrapped-year --github
```

Adds commits, pull requests, reviews and active days for the year, through the `gh` CLI you are already signed in to.

## Compare with friends

The second-to-last slide shows your friend code. Send it to a friend, and paste theirs into the slide to see your totals side by side. The share buttons post a link whose preview is your card, and it opens [aiyearwrapped.com](https://aiyearwrapped.com/) with the compare command filled in. A friend can also run:

```bash
npx ai-wrapped-year --vs sam=aw1-1ka.1.3e8.1kqsbm8.2s.e.9ix
```

A code holds the year, your persona and five totals: prompts, tokens, hours, streak and cost. Nothing else.

## Options

| Option | What it does |
| --- | --- |
| `--year <yyyy>` | Year to wrap. Default: this year, or last year during January |
| `--usage <file>` | Add a usage export (CSV) from an API console |
| `--cursor-csv <file>` | Add the usage export from Cursor's dashboard |
| `--paid <usd>` | What you pay per month across your plans, to compare with list prices |
| `--github` | Add your GitHub activity |
| `--compare` | Rank your totals against other wraps |
| `--api <url>` | Percentile server for `--compare` (or set `AGENT_WRAPPED_API`) |
| `--vs <code>` | Compare with a friend's code. `name=code` names them. Repeat for more friends |
| `--export <file>` | Save this machine's history to one file |
| `--import <file>` | Merge a file made by `--export` |
| `--doctor` | Show what was found for each tool |
| `--out <file>` | Where to write the page |
| `--serve <port>` | Serve the page on localhost instead of opening the file |
| `--json` | Print the numbers as JSON |
| `--data <file>` | Render from a saved `--json` file |
| `--no-open` | Don't open the browser |

## Privacy

Everything is computed on your machine. The page is a single file with your numbers inside it, and it makes no network requests.

Two options reach the network, and only when you pass them:

- `--github` asks GitHub for your contribution counts through `gh`.
- `--compare` sends five totals (prompts, tokens, hours, streak, cost), the year and a random id to the percentile server you name. No names, projects, models or dates.

A shared link carries your friend code and nothing else. The share server draws the preview image from the code and caches it.

The site, aiyearwrapped.com, counts page views and copied commands with PostHog, without cookies. Friend codes are removed before anything is sent.

Shell startup files and launcher scripts are searched for the variable names above, to find profiles, and nothing else is taken from them.

Prompts and replies are never stored, printed or sent. The archive holds timestamps, token counts, model names, tool names and project folder names.

## Cost

Cost is tokens multiplied by each model's public list price. It is what the usage would cost through the API, not what a subscription charged you. Models without a known price are left out and counted on the slide.

## Personas

Every wrap gets one persona. The slide and the share image say what it means in plain words and show the numbers behind it, so the card makes sense to someone who has never run this.

The list is checked from the top and the first one that fits is yours:

| Persona | What it means | You get it when |
| --- | --- | --- |
| The Night Shift | Works with AI late at night | 30% or more of your prompts were sent between 10pm and 5am |
| The Dawn Patrol | Starts with AI early in the morning | 30% or more of your prompts were sent between 5am and 9am |
| The Polyglot | Splits the work between AI tools | Your second most used tool got 20% or more of your prompts |
| The Weekend Builder | Builds on weekends | 35% or more of your prompts were sent on a Saturday or Sunday |
| The Juggler | Keeps many projects going at once | You worked on 5 or more projects and none got more than 30% of your prompts |
| The Deep Diver | Puts almost everything into one project | One project got 60% or more of your prompts |
| The Steady Hand | Works at an even pace | None of the above fits |

## Percentile server

`--compare` needs a server. One is included, with no dependencies:

```bash
PORT=8787 node server/percentiles.js
```

It keeps one row per install per year and shows ranks once 20 wraps exist (`MIN_WRAPS`). It stores no IP addresses.

## Share server

`share/` is the Cloudflare Worker behind share.aiyearwrapped.com. It turns a friend code into the link preview: a page with the card as its image, which sends people on to the site.

```bash
cd share && npm install && npx wrangler dev
```

`npx wrangler deploy` publishes it, from the Cloudflare account that holds aiyearwrapped.com.

## Adding a tool

A reader is one file in `src/parsers` that lists a tool's files and turns each one into events (`prompt`, `reply`, `tool`). Add it to `src/sources.js`, add a fixture test in `test/readers.test.js`, and run:

```bash
npm test
```

## License

MIT
