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
| `bob new <KEY>` | Do the same as `N` outside the view. |
| `bob --once` | Print one frame and exit. It reads no key. |
| `bob demo` or `bob -d` | Show fake sessions. It touches no real state. |
| `bob install` | Print the hook entries Bob needs. |
| `bob install --write` | Merge the entries into `~/.claude/settings.json`. |
| `bob prune` | Delete rows not updated in 7 days. Bob shows the count and asks y/N first. Add `--older-than <age>` (a number and `s`, `m`, `h`, `d`, or `w`, such as `12h`) to change the age. Add `--yes` or `-y` to skip the question. |
| `bob hook` | The hook that Claude runs. It reads the event on stdin. |

## Config

`~/.config/bob/config.json` (set `BOB_CONFIG_DIR` to move it):

```json
{ "repo": "/home/me/code/app", "startPrompt": "/engineering:work-on <KEY>" }
```

`repo` is required and absolute. `startPrompt` is optional; `<KEY>` becomes the ticket key. Bob finds the ticket on a row through the worktree folder name.

## Bob in a layout pane

One command opens a multiplexer with Bob in a pane beside a shell. Bob must be on `PATH` (install step 3).

| Multiplexer | Command |
| --- | --- |
| zellij | `zellij --layout ~/code/bob/layouts/bob.kdl` |
| tmux | `tmux new-session bob \; split-window -h` |

Press Enter in Bob to focus a session's pane. Press `n` to open a new Claude pane.

## How to read the list

Rows sort waiting first (longest wait on top), then busy, then idle, then stale.

| Icon | Status | Meaning |
| --- | --- | --- |
| `◆` | waiting | Claude waits on you. The reason is the `Notification` message. |
| `●` | busy | A turn runs. |
| `○` | idle | The turn ended. |
| `◌` | stale | No update for 3600 seconds. |

The context bar has 8 cells. 300k tokens fills it, and the percentage is tokens divided by 300k. The colour follows the token count: green below 100k, yellow below 200k, amber below 300k, red above. Bob reads the token count and the model from the last entry of the session transcript.

The PR column shows the PR state (`draft`, `open`, `merged`, `closed`), the CI result (`✓` pass, `✗` fail, `…` pending, `-` none), and the review decision (`appr`, `chg`, `rev`). Bob finds the branch with `git rev-parse` in the row's folder and polls `gh pr view` from the view process. It needs `gh` signed in. A folder with no PR shows no cell, and no row with a PR means no column. Each folder gets one call at a time, a 30 second TTL, old data while a refresh runs, and a 2 minute back-off after an error. `bob --once` makes no call. Below 110 columns the model column goes, and below 83 the PR column goes.

Colour shows only on a terminal. Set `NO_COLOR` to turn it off.

## Where Bob keeps state

- The hook writes one SQLite file, `~/.local/state/bob/bob.db`, in one transaction. It writes inside no repo.
- Set `BOB_STATE_DIR` to an absolute path to use another folder.
- The hook exits 0 on any error, so it never blocks Claude.
- The hook deletes a row on `SessionEnd`. A session that dies with no `SessionEnd` leaves a row that goes stale and sorts last.
- `bob prune` is the one command that deletes rows on your say-so. Plain `bob`, `bob --once`, and `bob demo` write nothing.

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
