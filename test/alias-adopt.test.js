import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { isSemanticPrefix } from '../lib/session-files.js'

function frame(events) {
  return zlib.zstdCompressSync(Buffer.from(events.map((event) => JSON.stringify(event)).join('\n') + '\n'))
}
function event(seq, text) {
  return { type: 'user/message', seq, time: 1000 + seq, data: { content: [{ type: 'text', text }], role: 'user', id: `u-${seq}` }, surfaceOp: 'append' }
}

test('an alias snapshot that is a semantic prefix of the peer log is adoptable', () => {
  const local = Buffer.concat([frame([event(0, 'a')]), frame([event(1, 'b')])])
  const remote = Buffer.concat([local, frame([event(2, 'c')])])
  assert.equal(isSemanticPrefix(local, remote), true)
})

test('a diverged local log is not a prefix and is never adopted', () => {
  const local = frame([event(0, 'a'), event(1, 'local-only')])
  const remote = frame([event(0, 'a'), event(1, 'peer-only')])
  assert.equal(isSemanticPrefix(local, remote), false)
})
