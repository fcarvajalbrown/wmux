# repro-prompt-overlap

Headless reproduction of PowerShell input being drawn over the prompt after a pane is resized. It drives the same stack a wmux terminal pane uses, with no window: a real ConPTY `powershell.exe` through `node-pty`, spawned with wmux's launch arguments and its PowerShell integration script, feeding an `@xterm/headless` 6.0.0 terminal built with wmux's options (`windowsPty`, `reflowCursorLine`). On each resize it resizes xterm first and the PTY second, as the renderer's fit does. Then it types text at the prompt and compares the logical cursor line with the prompt plus that text.

```bash
node tools/repro-prompt-overlap/repro.mjs --cwd "C:\Users\Beetlejuice\Desktop\Corpofobia" --sizes 120x30,40x30,120x30
```

Options: `--sizes` (comma list of `COLSxROWS`, first is the spawn size), `--type`, `--settle-ms`, `--shell`, `--out FILE.json` (writes every step with its viewport). Switches that turn one wmux piece off: `--no-integration`, `--no-reflow-cursor-line`, `--no-windows-pty`, `--inbox-conpty` (Windows' conpty instead of node-pty's bundled `conpty.dll`). Exit code is 1 when any step fails.

## Result

Windows 10 Home 22H2 (build 19045), Windows PowerShell 5.1, prompt `PS C:\Users\Beetlejuice\Desktop\Corpofobia>` (46 columns), sizes 120x30, 40x30, 120x30, typing `codex`.

| Variant | 120x30 | 40x30 | back to 120x30 |
|---|---|---|---|
| wmux defaults | pass | fail: input wrapped onto its own row | fail: `PS Ccodexrs\Beetlejuice\Desktop\Corpofobia>` |
| `--no-integration` | pass | fail | fail, same line |
| `--no-reflow-cursor-line` | pass | fail | fail, same line |
| `--no-windows-pty` | pass | pass | fail, same line |
| `--no-integration --no-reflow-cursor-line --no-windows-pty` | pass | fail: `    codex` | fail: `PS Ccodexrs\Beetlejuice\Desktop\Corpofob` |
| `--inbox-conpty` | pass | fail | fail, same line |
| `--inbox-conpty --no-integration --no-reflow-cursor-line --no-windows-pty` | pass | fail: `ia> codex` | fail, same line |
| control: prompt `PS C:\Users\Beetlejuice>` (25 columns) | pass | pass | pass |

The trigger is the pane becoming narrower than the prompt. Once that happens, input lands over the prompt at every later size. It reproduces with the integration script, `reflowCursorLine` and `windowsPty` all off, and with either conpty, so none of those wmux pieces causes it.
