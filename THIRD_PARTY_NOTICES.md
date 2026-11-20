# Third-party notices

This bundle is an independent implementation written for this repository. Its
protocol shape and the last-mile session-adoption approach were informed by two
MIT-licensed public projects. No source file was copied verbatim, but the
following works deserve attribution:

- **XXGxiaoyu/dsh-session-sync** (npm `dsh-session-sync-xxg`) — LAN discovery,
  catalog/export endpoint layout, checksum-before-write, fingerprint-based
  deduplication, and importing through `ctx.sessionPersistence`.
  https://github.com/XXGxiaoyu/dsh-session-sync

- **FrozMN/dsh-session-adopt** — adopting sessions that exist outside the
  running window with `workspace.attachSession()` and refreshing the sidebar.
  https://github.com/FrozMN/dsh-session-adopt

Both projects are distributed under the MIT License:

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
