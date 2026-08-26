import type { IDisposable, Terminal } from '@xterm/headless'
import type { TerminalOwner } from '../../shared/terminal-owner'

const ALTERNATE_SCREEN_MODES = new Set([47, 1047, 1049])
const TUI_MODE_ENABLES = new Set([47, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 1047, 1049])

export type TerminalShellOwnership = {
  getOwner: () => TerminalOwner | undefined
  seedOwner: (owner: TerminalOwner | undefined) => void
  setConfirmation: (confirm: (() => Promise<boolean>) | undefined) => void
  settleConfirmation: () => Promise<void>
  dispose: () => void
}

/** Tracks shell ownership from mode and command lifecycle events parsed in byte order. */
export function installTerminalShellOwnership(terminal: Terminal): TerminalShellOwnership {
  let owner: TerminalOwner | undefined
  let commandEnteredAlternateScreen = false
  let candidateGeneration = 0
  let confirmationGeneration = 0
  let confirm: (() => Promise<boolean>) | undefined
  let confirmation: Promise<void> | null = null
  let queuedCandidate: number | undefined
  const revoke = (): void => {
    candidateGeneration += 1
    queuedCandidate = undefined
    owner = undefined
  }
  const confirmCandidate = (candidate: number): void => {
    if (!confirm) {
      return
    }
    if (confirmation) {
      queuedCandidate = candidate
      return
    }
    const requestedGeneration = confirmationGeneration
    const pending = confirm()
      .then((confirmed) => {
        if (
          confirmed &&
          requestedGeneration === confirmationGeneration &&
          candidate === candidateGeneration
        ) {
          owner = 'shell'
        }
      })
      .catch(() => {})
      .finally(() => {
        if (confirmation === pending) {
          confirmation = null
        }
        const nextCandidate = queuedCandidate
        queuedCandidate = undefined
        if (nextCandidate === candidateGeneration) {
          confirmCandidate(nextCandidate)
        }
      })
    confirmation = pending
  }
  const disposables: IDisposable[] = [
    terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      let revokesOwner = false
      let enteredAlternateScreen = false
      for (let index = 0; index < params.length; index += 1) {
        const param = params[index]
        if (typeof param !== 'number') {
          continue
        }
        revokesOwner ||= TUI_MODE_ENABLES.has(param)
        enteredAlternateScreen ||= ALTERNATE_SCREEN_MODES.has(param)
      }
      if (revokesOwner) {
        revoke()
      }
      if (enteredAlternateScreen) {
        commandEnteredAlternateScreen = true
      }
      return false
    }),
    terminal.parser.registerOscHandler(133, (data) => {
      const lifecycle = data.split(';', 1)[0]
      if (lifecycle === 'C') {
        revoke()
        commandEnteredAlternateScreen = false
      } else if (
        lifecycle === 'D' &&
        (commandEnteredAlternateScreen || terminal.buffer.active.type === 'alternate')
      ) {
        revoke()
        commandEnteredAlternateScreen = false
        confirmCandidate(candidateGeneration)
      }
      return false
    })
  ]

  return {
    getOwner: () => owner,
    seedOwner(nextOwner) {
      owner = nextOwner
    },
    setConfirmation(nextConfirmation) {
      confirmationGeneration += 1
      queuedCandidate = undefined
      confirm = nextConfirmation
    },
    async settleConfirmation() {
      while (confirmation) {
        await confirmation
      }
    },
    dispose() {
      confirmationGeneration += 1
      queuedCandidate = undefined
      confirm = undefined
      for (const disposable of disposables) {
        disposable.dispose()
      }
    }
  }
}
