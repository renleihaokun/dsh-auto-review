/**
 * Desktop-branch regression tests (DeepSeek Harness `0.2.0-rc.2` port).
 *
 * Every case pins a behaviour this branch INTRODUCED or FIXED, so a later
 * refactor cannot silently restore the defect:
 *
 *  - inline-secret redaction of free-form string arguments (the key-based pass
 *    could never see a secret spelled inside a shell command line), on BOTH
 *    rendering paths — the pending call's own preview and the transcript line;
 *  - the TRUNCATED disclosure on the preview, and the prompt rule that makes
 *    truncated evidence a denial;
 *  - the permission-preset gate, which is AUTHORITATIVE over the session
 *    switch and fails CLOSED when the preset cannot be read;
 *  - the dependency policy that keeps this package from hoisting a competing
 *    harness tree over a consumer profile.
 * @module dsh-auto-review/test/desktop-port.spec
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CommandId } from '@deepseek-ai/dsh-commands'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { Session, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { CallId } from './call-id.ts'
import {
  buildContextSection,
  buildReviewPrompt,
  effectiveAutoReviewState,
  PRESET_GATE,
  renderCallContext,
  resolveConfig,
  sanitizeArguments,
} from '../src/index.ts'
import { dispatchAskedApproval, makeAgent, mountHarness } from './harness.ts'

type Harness = Awaited<ReturnType<typeof mountHarness>>

/** One raw `tool/call` event carrying `arguments` verbatim, as the runtime reads it. */
function callEvent(argumentsText: string): never {
  return {
    type: 'tool/call',
    seq: 0,
    time: 0,
    data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: argumentsText },
  } as never
}

/** A real session, for the prompt builders that read `request.agent.session`. */
function bareSession(id: string): Session {
  return Session.create(SessionId(id), undefined, {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 0,
    cwd: path.resolve('work'),
    isSeeded: false,
  })
}

/** The registered `/auto-review` command definition. */
function autoReview(harness: Harness): CommandDefinition {
  const definition = harness.commands.registered.find(candidate => candidate.name === 'auto-review')
  if (definition === undefined) throw new Error('/auto-review was never registered')
  return definition
}

/** Run the command the way the client runner does. */
function invoke(harness: Harness, rawInput: string): { kind: string; text: string } {
  return autoReview(harness).handler({
    commandId: CommandId('cmd-1'),
    agent: harness.agent,
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  }) as { kind: string; text: string }
}

/**
 * Provide the profile's permission-preset service. The gate reads it through
 * `ctx.get` (never `inject`), so an arbitrary service can be attached here.
 */
function providePresets(harness: Harness, current: () => string): void {
  (harness.ctx as unknown as { provide(name: string, value: unknown): void })
    .provide('permissionPresets', { current })
}

describe('inline-secret redaction (port F3)', () => {
  it('masks KEY=VALUE, KEY: VALUE and --flag VALUE inside a free-form string', () => {
    const sanitized = sanitizeArguments({
      command: 'deploy --token sk-live-123 --api-key=ak-9 API_SECRET="s3cr3t" PASSWORD=hunter2',
      file_path: '/tmp/plain.txt',
    }) as Record<string, string>
    expect(sanitized.command).toContain('[REDACTED]')
    for (const secret of ['sk-live-123', 'ak-9', 's3cr3t', 'hunter2']) {
      expect(sanitized.command, `leaked ${secret}`).not.toContain(secret)
    }
    // A value with no secret-shaped key next to it is untouched.
    expect(sanitized.file_path).toBe('/tmp/plain.txt')
  })

  it('masks the credential but keeps the Authorization scheme readable', () => {
    const sanitized = sanitizeArguments({
      command: 'curl -H "Authorization: Bearer tok-42" https://example.invalid',
    }) as Record<string, string>
    expect(sanitized.command).toContain('Authorization')
    expect(sanitized.command).toContain('Bearer')
    expect(sanitized.command).not.toContain('tok-42')
  })

  it('leaves a bare secret with no adjacent key visible — the documented best-effort limit', () => {
    // Pinned deliberately: this is a KNOWN limitation, not an accident. If the
    // heuristic is ever strengthened, this case must be updated on purpose.
    const sanitized = sanitizeArguments({ command: 'echo sk-live-123' }) as Record<string, string>
    expect(sanitized.command).toContain('sk-live-123')
  })

  it('redacts the TRANSCRIPT line as well as the pending call (port F3c)', () => {
    // The transcript is a separate rendering path from the pending call's own
    // preview, and before F3c it passed `arguments` through verbatim.
    const transcript = buildContextSection([callEvent('deploy --token sk-live-123')], { turns: 1, maxChars: 4000 })
    expect(transcript).toContain('[tool call bash]')
    expect(transcript).toContain('[REDACTED]')
    expect(transcript).not.toContain('sk-live-123')
  })
})

describe('truncated-evidence disclosure (port F4)', () => {
  it('discloses truncation with the exact counts instead of a silent ellipsis', () => {
    const text = renderCallContext([callEvent(JSON.stringify({ command: 'x'.repeat(4000) }))], CallId('call-1'), 2000)
    expect(text).toContain('TRUNCATED')
    expect(text).toMatch(/only the first 2000 of \d+ characters/)
    expect(text).toContain('NOT visible to you')
  })

  it('does not claim truncation for a preview that fits', () => {
    const text = renderCallContext([callEvent('{"command":"echo hi"}')], CallId('call-1'), 2000)
    expect(text).not.toContain('TRUNCATED')
    expect(text).toContain('echo hi')
  })

  it('states the matching deny rule in the prompt', () => {
    const prompt = buildReviewPrompt({ agent: makeAgent(bareSession('port-prompt')), toolName: 'bash' }, resolveConfig({}))
    expect(prompt).toContain('- truncated evidence counts as insufficient')
  })
})

describe('permission-preset gate (port F1/F2)', () => {
  it('claims a request while the preset is the gate preset', async () => {
    const harness = await mountHarness({ allowUnmarkedAudit: true, toolsPolicy: { overrides: { bash: 'ai' } } })
    providePresets(harness, () => PRESET_GATE)
    const { outcome } = await dispatchAskedApproval(harness.ctx, harness.session, {
      agent: harness.agent,
      toolName: 'bash',
      callId: CallId('call-1'),
      reason: 'escalate sandbox',
    }, async () => 'human-allowed-once')
    expect(harness.subagents.starts).toHaveLength(1)
    expect(outcome).toBe('allowed-once')
  })

  it('never claims a request while the preset is not the gate preset, even with enableByDefault on', async () => {
    const harness = await mountHarness({
      allowUnmarkedAudit: true,
      enableByDefault: true,
      toolsPolicy: { overrides: { bash: 'ai' } },
    })
    providePresets(harness, () => 'workspace-write')
    let downstreamCalled = false
    const { outcome } = await dispatchAskedApproval(harness.ctx, harness.session, {
      agent: harness.agent,
      toolName: 'bash',
      reason: 'escalate sandbox',
    }, async () => {
      downstreamCalled = true
      return 'human-allowed-once'
    })
    expect(harness.subagents.starts).toHaveLength(0)
    expect(downstreamCalled).toBe(true)
    expect(outcome).toBe('human-allowed-once')
  })

  it('fails CLOSED when the preset cannot be read, so a stale override cannot re-open the gate', async () => {
    const harness = await mountHarness({ allowUnmarkedAudit: true, toolsPolicy: { overrides: { bash: 'ai' } } })
    // Auto-review is explicitly ON in this session's own log...
    invoke(harness, 'off')
    invoke(harness, 'on')
    expect(effectiveAutoReviewState(harness.session.snapshotEvents())).toBe(true)
    // ...and the mounted preset service now throws on every read.
    providePresets(harness, () => {
      throw new Error('preset read failed')
    })
    let downstreamCalled = false
    await dispatchAskedApproval(harness.ctx, harness.session, {
      agent: harness.agent,
      toolName: 'bash',
      reason: 'escalate sandbox',
    }, async () => {
      downstreamCalled = true
      return 'human-allowed-once'
    })
    expect(harness.subagents.starts).toHaveLength(0)
    expect(downstreamCalled).toBe(true)
  })

  it('refuses `/auto-review on` while the gate is closed instead of recording a dead override', async () => {
    const harness = await mountHarness({ allowUnmarkedAudit: true })
    let preset = PRESET_GATE
    providePresets(harness, () => preset)
    expect(invoke(harness, 'off')).toMatchObject({ kind: 'success' })
    preset = 'workspace-write'
    const refused = invoke(harness, 'on')
    expect(refused.kind).toBe('error')
    expect(refused.text).toContain(PRESET_GATE)
    expect(refused.text).toContain(`/permission ${PRESET_GATE}`)
    // The refused switch wrote nothing: the session is still OFF.
    expect(effectiveAutoReviewState(harness.session.snapshotEvents())).toBe(false)
  })

  it('falls back to enableByDefault when the profile composes no preset service', async () => {
    const harness = await mountHarness({
      allowUnmarkedAudit: true,
      enableByDefault: true,
      toolsPolicy: { overrides: { bash: 'ai' } },
    })
    await dispatchAskedApproval(harness.ctx, harness.session, {
      agent: harness.agent,
      toolName: 'bash',
      reason: 'escalate sandbox',
    }, async () => 'human-allowed-once')
    expect(harness.subagents.starts).toHaveLength(1)
  })
})

describe('dependency policy (port: no harness shadowing)', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

  it('declares no @deepseek-ai/* runtime dependency', () => {
    // Upstream keeps the harness integration packages in `dependencies` so the
    // shipped dsh-eval face works out of the box. Installing such a package
    // HOISTS that tree over the profile's own runtime, so any version skew
    // between the two crashes boot. This branch removes the hazard instead of
    // pinning around it: nothing here may ever resolve into a profile.
    const offenders = Object.keys(manifest.dependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/'))
    expect(offenders).toEqual([])
  })

  it('keeps the toolchain a git install needs to build this package', () => {
    // The isolated prepare environment of a git install has no devDependencies,
    // so the build toolchain must stay a runtime dependency.
    for (const name of ['tsdown', 'typescript', 'zod', 'yaml']) {
      expect(manifest.dependencies, `missing build dependency ${name}`).toHaveProperty(name)
    }
  })

  it('keeps the moved integration packages available to the tests', () => {
    for (const name of ['@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-subagent-spawn-in-process']) {
      expect(manifest.devDependencies).toHaveProperty(name)
    }
  })
})
