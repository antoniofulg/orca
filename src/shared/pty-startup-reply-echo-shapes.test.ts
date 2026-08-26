/**
 * The echo shapes here are TRANSCRIBED FROM A LIVE PTY, not derived from the spec: each
 * `echo` is what `/bin/bash` actually emitted after the reply was written to the master,
 * captured under node-pty at a readline prompt (tty raw, readline echoes in software) and
 * under a `read` builtin (tty cooked, kernel ECHOCTL echoes).
 *
 * Two shapes matched nothing before this file existed: an OSC reply on a cooked tty (its
 * trailing BEL prints as `^G`, and only ESC was caret-encoded) and any private DSR at a
 * readline prompt (the readline projection was gated on an OSC introducer).
 */
import { describe, expect, it } from 'vitest'
import { locateEcho, replyEchoProjections } from './pty-startup-reply-echo-shapes'

const OSC11_BEL = '\x1b]11;rgb:2e2e/3434/3434\x07'
const OSC11_ST = '\x1b]11;rgb:2e2e/3434/3434\x1b\\'
const OSC10_BEL = '\x1b]10;rgb:c6c6/c6c6/c6c6\x07'
const DSR_997 = '\x1b[?997;1n'
const DSR_996 = '\x1b[?996n'

/** `readline` = tty raw at a bash prompt; `cooked` = kernel ECHOCTL under `read`. */
const LIVE_ECHOES: readonly { name: string; reply: string; echo: string }[] = [
  { name: 'OSC 11 BEL / readline', reply: OSC11_BEL, echo: '\x0711;rgb:2e2e/3434/3434\x07' },
  { name: 'OSC 11 ST / readline', reply: OSC11_ST, echo: '\x0711;rgb:2e2e/3434/3434' },
  { name: 'OSC 10 BEL / readline', reply: OSC10_BEL, echo: '\x0710;rgb:c6c6/c6c6/c6c6\x07' },
  { name: 'DSR 997 / readline', reply: DSR_997, echo: '\x07997;1n' },
  { name: 'DSR 996 / readline', reply: DSR_996, echo: '\x07996n' },
  { name: 'OSC 11 BEL / cooked', reply: OSC11_BEL, echo: '^[]11;rgb:2e2e/3434/3434^G' },
  { name: 'OSC 11 ST / cooked', reply: OSC11_ST, echo: '^[]11;rgb:2e2e/3434/3434^[\\' },
  { name: 'OSC 10 BEL / cooked', reply: OSC10_BEL, echo: '^[]10;rgb:c6c6/c6c6/c6c6^G' },
  { name: 'DSR 997 / cooked', reply: DSR_997, echo: '^[[?997;1n' },
  { name: 'DSR 996 / cooked', reply: DSR_996, echo: '^[[?996n' }
]

describe('replyEchoProjections on a POSIX pty', () => {
  it.each(LIVE_ECHOES)('matches the live $name echo', ({ reply, echo }) => {
    const match = locateEcho(replyEchoProjections(reply, 'posix-pty'), echo)
    expect(match).toEqual({ kind: 'complete', offset: 0, length: echo.length })
  })

  // The tty coalesces its echo with surrounding shell output, so anchoring at offset 0
  // would recognize almost no real echo.
  it.each(LIVE_ECHOES)('finds the $name echo embedded in output', ({ reply, echo }) => {
    const match = locateEcho(replyEchoProjections(reply, 'posix-pty'), `user@host:~$ ${echo} `)
    expect(match).toEqual({ kind: 'complete', offset: 13, length: echo.length })
  })

  // `stty -echoctl` echoes the reply verbatim.
  it.each(LIVE_ECHOES.map((entry) => entry.reply))('matches the verbatim echo of %j', (reply) => {
    expect(locateEcho(replyEchoProjections(reply, 'posix-pty'), reply).kind).toBe('complete')
  })

  it('caret-encodes every control, not just ESC', () => {
    const [kernel] = replyEchoProjections(OSC11_BEL, 'posix-pty')
    expect(kernel?.needle).toBe('^[]11;rgb:2e2e/3434/3434^G')
    expect(kernel?.needle).not.toContain('\x07')
  })

  it('projects readline for a private DSR, which carries no OSC introducer', () => {
    const needles = replyEchoProjections(DSR_997, 'posix-pty').map(
      (projection) => projection.needle
    )
    expect(needles).toContain('\x07997;1n')
  })

  // A needle starting with ESC must never be held as a partial: a read ending on a bare
  // ESC is a strict prefix of it, and an expired hold would release a stolen query raw.
  it('holds a partial only for needles that do not start with ESC', () => {
    for (const { reply } of LIVE_ECHOES) {
      for (const projection of replyEchoProjections(reply, 'posix-pty')) {
        expect(projection.holdPartial).toBe(!projection.needle.startsWith('\x1b'))
      }
    }
  })
})

describe('replyEchoProjections on other backends', () => {
  it('keeps ConPTY on its documented ESC-stripped form', () => {
    expect(replyEchoProjections(DSR_997, 'windows-conpty')).toEqual([
      { needle: '[?997;1n', holdPartial: true }
    ])
  })

  it('suppresses nothing when the echo shape is unverified', () => {
    expect(replyEchoProjections(DSR_997, 'windows-wsl')).toEqual([])
  })
})
