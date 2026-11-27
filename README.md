# Bob

A live terminal list of your Claude Code sessions. For each session it shows the status, the time in that status, the context use, the model, the folder, and, for a waiting session, the reason it waits.

```
STATUS          AGE  CONTEXT        MODEL       FOLDER                REASON
◆ waiting    23m20s  ████░░░░  50%  sonnet-5-5  api-server            Allow Bash: npm test?
● busy        1m35s  ███░░░░░  40%  haiku-5-5   docs-site
○ idle       13m20s  ████████ 113%  opus-5-5    dotfiles
◌ stale       1h06m  ░░░░░░░░   6%  opus-5-5    old-experiment
```

Bob sends no input to a session. It edits no Claude file unless you run `bob install --write` and say yes.

## Requirements

- Node 26 or later. Bob uses only Node built-ins, so it needs no `npm install` to run.
- Claude Code with hooks enabled.

## Install from a release

1. Download `bob-<version>.tar.gz` from the release page and unpack it: `tar -xzf bob-<version>.tar.gz`
2. Run `sh bob-<version>/install.sh`. It checks that `node --version` is 26 or later, copies Bob to `~/.local/share/bob` (`BOB_PREFIX`), and links `bob` into `~/.local/bin` (`BOB_BIN`).
3. Run `bob install --write` as in step 6 below.

The installer needs Node 26 and refuses to run without it. It does not embed Node, so the goal of running on a machine with no Node is not met, by design: see `docs/decisions/installer.md`. Build the tarball with `sh scripts/build-release.sh`.

## Install from source

1. Clone the repo: `git clone git@github.com:xxKeefer/bob.git ~/code/bob`
2. Check Node: `node --version`
3. Link the command: `ln -s ~/code/bob/bin/bob.ts ~/.local/bin/bob`
4. Check that `~/.local/bin` is on your PATH: `command -v bob`
5. Print the hook entries: `bob install`
6. Merge them into `~/.claude/settings.json`: `bob install --write`. Bob shows the change, asks y/N, and backs up the file first. A second run adds no duplicate. Without a `bob` link on `PATH`, it warns that the hook points into the checkout and breaks if you move or delete it.
7. Start a new Claude session, then run `bob`.

A session that began before step 6 has no row until you submit a prompt in it.

If another tool or your employer manages your Claude settings, run step 5 only and add the entries by hand.

To update, run `git pull` in the clone.

## Commands

| Command | Does |
| --- | --- |
| `bob` | Show the live list. It refreshes each second. Move the highlighted row with `j` and `k` or the down and up arrows. Press Enter to focus the selected session's tmux or zellij pane. Press `q` or Ctrl-C to quit. |
| `n` | Open a new tmux or zellij pane in the selected row's folder and run `claude`. Bob sends it no text. |
| `N` | Type a ticket key such as `ABC-123` and press Enter. Bob runs `wt switch --create` in your repo, opens a tmux window or zellij pane in the new worktree, and runs `claude` with the start prompt. Esc cancels. |
| `v` | Type a PR number such as `27` and press Enter. Bob runs `gh pr view <n> --json headRefName` in your repo, runs `wt switch <branch>`, opens a tmux window or zellij pane in that worktree, and runs `claude` with the review prompt. The row shows `review` before its folder and sorts after ticket rows of the same status. Bob posts nothing to GitHub. Esc cancels. |
| `x` | Clean up the selected row after its PR merged. Bob asks y/N in the view. On `y` it re-checks with `gh pr view` that the PR is merged, runs `wt remove <branch>` in your configured repo, closes the row's tmux window (`kill-window`) or zellij pane (`close-pane`), and deletes the row. If the PR is not merged, or Bob cannot prove it, Bob shows a message and does nothing. Any key but `y` cancels. |
| `r` | Restart a stuck row. In tmux, Bob runs `tmux respawn-pane -k -t <pane> -c <folder> claude --continue`, which kills the pane process and resumes the same conversation in the same pane. On a row that is not stuck, Bob shows a message and does nothing. zellij has no clean equivalent of `respawn-pane`, so in zellij Bob shows `restart not supported in zellij`. |
| `bob new <KEY>` | Do the same as `N` outside the view. |
| `bob proxy` | Run the dev proxy. It listens on `127.0.0.1:8181` (`proxyPort`) and forwards each request, and each websocket upgrade, to the dev server of the row selected in the view. It answers 503 when no row is selected or the row has no recorded port, and 502 when the dev server does not answer. It needs `devCommand` in the config. |
| `bob --once` | Print one frame and exit. It reads no key. |
| `bob demo` or `bob -d` | Show fake sessions. It touches no real state. |
| `bob install` | Print the hook entries Bob needs. |
| `bob install --write` | Merge the entries into `~/.claude/settings.json`. |
| `bob prune` | Delete rows not updated in 7 days. Bob shows the count and asks y/N first. Add `--older-than <age>` (a number and `s`, `m`, `h`, `d`, or `w`, such as `12h`) to change the age. Add `--yes` or `-y` to skip the question. |
| `bob statusline` | Print "N waiting" for the Claude status line, or an empty line when none wait. It skips the calling session and writes nothing. |
| `bob hook` | The hook that Claude runs. It reads the event on stdin. |

## Status line

To show the waiting count in each Claude session, set the status line command in `~/.claude/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "bob statusline" } }
```

Claude sends the session JSON on stdin. Bob reads the `session_id` and leaves that session out of the count. Bob needs `bob` on `PATH` (install step 3). To keep an existing status line, run both commands in one script and join their output.

## Config

`~/.config/bob/config.json` (set `BOB_CONFIG_DIR` to move it):

```json
{ "repo": "/home/me/code/app", "startPrompt": "/engineering:work-on <KEY>", "reviewPrompt": "/engineering:review-pr <N>" }
```

`repo` is required and absolute. `startPrompt` is optional; `<KEY>` becomes the ticket key. `reviewPrompt` is optional; `<N>` becomes the PR number. `stuckSeconds` is optional, a positive number, default 300; see stuck below. `planDir` is optional and absolute, default `~/studio/work/.ai/reports`; `BOB_PLAN_DIR` overrides it. Bob marks a review row by saving the worktree folder in `reviews.json` in the state folder. Bob finds the ticket on a row through the worktree folder name.

## Dev server and stable URL

Off unless the config has `devCommand`. Add these keys to `config.json`:

```json
{ "devCommand": ["npm", "run", "dev"], "devEnvFile": ".env.local", "devPortRange": [4100, 4199], "proxyPort": 8181 }
```

`devCommand` is an argv list, never a shell string. `devEnvFile` is a bare file name, default `.env.local`. `devPortRange` is two ports from 1024 up, default `[4100, 4199]`. `proxyPort` is default 8181. A bad value turns the feature off.

After `N` or `bob new` opens a ticket window, Bob picks a free port in the range, sets the `PORT=` line in `devEnvFile` in the worktree (other lines stay), saves folder to port in `ports.json` in the state folder, and opens a second detached tmux window or zellij pane in the worktree running `env PORT=<n> <devCommand>`. A reused worktree keeps its port when it is still free.

While the view runs, it writes the selected row's folder to `selected` in the state folder on each selection change. Run `bob proxy` in another pane, then load `http://localhost:8181`: it shows the dev server of the selected row, and selecting another row and reloading shows that row's server. The proxy re-reads both files on each request and ignores any folder that is not absolute.

## Bob in a layout pane

One command opens a multiplexer with Bob in a pane beside a shell. Bob must be on `PATH` (install step 3).

| Multiplexer | Command |
| --- | --- |
| zellij | `zellij --layout ~/code/bob/layouts/bob.kdl` |
| tmux | `tmux new-session bob \; split-window -h` |

Press Enter in Bob to focus a session's pane. Press `n` to open a new Claude pane.

## How to read the list

Rows sort waiting first (longest wait on top), then stuck, then busy, then idle, then stale.

| Icon | Status | Meaning |
| --- | --- | --- |
| `◆` | waiting | Claude waits on you. The reason is the `Notification` message. |
| `●` | busy | A turn runs. |
| `○` | idle | The turn ended. |
| `■` | stuck | A busy row whose transcript file has not changed for `stuckSeconds` (default 300). Press `r` to restart it. A busy row with no readable transcript never shows stuck. |
| `◌` | stale | No update for 3600 seconds. |

The context bar has 8 cells. 300k tokens fills it, and the percentage is tokens divided by 300k. The colour follows the token count: green below 100k, yellow below 200k, amber below 300k, red above. Bob reads the token count and the model from the last entry of the session transcript.

The PLAN column shows done and total steps, such as `3/7`. Bob takes the ticket key from the row's folder name, reads the newest `plan_*.md` in `<planDir>/<KEY>/`, and counts the `- [x] **N. title.**` lines against all step lines under `## Steps`. Bob only reads. It caches by file mtime. A row with no plan shows no cell, and no plan means no column. Below 120 columns the PLAN column goes before the PR column.

The PR column shows the PR state (`draft`, `open`, `merged`, `closed`), the CI result (`✓` pass, `✗` fail, `…` pending, `-` none), and the review decision (`appr`, `chg`, `rev`). Bob finds the branch with `git rev-parse` in the row's folder and polls `gh pr view` from the view process. It needs `gh` signed in. A folder with no PR shows no cell, and no row with a PR means no column. Each folder gets one call at a time, a 30 second TTL, old data while a refresh runs, and a 2 minute back-off after an error. `bob --once` makes no call. Below 110 columns the model column goes, and below 83 the PR column goes.

Colour shows only on a terminal. Set `NO_COLOR` to turn it off.

## Where Bob keeps state

- The hook writes one SQLite file, `~/.local/state/bob/bob.db`, in one transaction. It writes inside no repo.
- Set `BOB_STATE_DIR` to an absolute path to use another folder.
- The hook exits 0 on any error, so it never blocks Claude.
- The hook deletes a row on `SessionEnd`. A session that dies with no `SessionEnd` leaves a row that goes stale and sorts last.
- With `devCommand` set, Bob also writes `ports.json` and `selected` in the state folder, and one `PORT=` line in the worktree env file.
- `bob prune` and the `x` key are the writes that delete rows on your say-so. `x` also removes a worktree and closes a window, and only for a merged PR. Plain `bob`, `bob --once`, and `bob demo` write nothing.

## Develop

```sh
npm install
npm run dev
npm run dev -- -d
npm test
npm run typecheck
npm run lint
```

`npm run dev` restarts Bob when a file in `src` or `bin` changes. Add `-d` to use fake data.

CI runs `npm test`, `npm run typecheck`, and `npm run lint` on every PR and every push to `main`.

## Releases

None yet. The version is `0.0.0`. The next goal is a release page with a binary and an installer, so a machine needs a download and no clone.
