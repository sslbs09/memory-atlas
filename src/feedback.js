/**
 * feedback.js - review signals, kept apart from the facts.
 *
 * A feedback entry is a governance side-channel, not a memory: an agent (or a
 * person) flags a record as useful or possibly incorrect, and a human decides
 * what to do. Writing feedback never changes a record's status, never enters
 * search, and never becomes a fact. "The agent may report; only the person may
 * convict."
 *
 * Storage is append-only JSONL, one file per space under <dataDir>/feedback/.
 * A resolution is a second appended entry that references the feedback id; the
 * current state is replayed from the log, the same discipline the activation
 * ledger uses. Nothing is mutated in place, so the review history stays auditable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertId, isIdLike } from './model.js';

export const FEEDBACK_SIGNALS = ['useful', 'incorrect'];
export const FEEDBACK_RESOLUTIONS = ['dismissed', 'actioned'];
const MAX_NOTE = 1000;

function invalid(message, code = 'ATLAS_FEEDBACK_INVALID') {
  return Object.assign(new Error(message), { code });
}

export function createFeedbackStore(dataDir) {
  if (!dataDir) throw new Error('createFeedbackStore requires a data directory.');
  const dir = path.join(dataDir, 'feedback');

  function fileFor(spaceId) {
    assertId(spaceId, 'spaceId');
    return path.join(dir, `${spaceId}.jsonl`);
  }

  function append(spaceId, entry) {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(fileFor(spaceId), `${JSON.stringify(entry)}\n`, 'utf8');
  }

  function readLog(spaceId) {
    let raw;
    try {
      raw = fs.readFileSync(fileFor(spaceId), 'utf8');
    } catch {
      return { entries: [], unreadable: false };
    }
    const entries = [];
    let unreadable = false;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') entries.push(parsed);
        else unreadable = true;
      } catch {
        // A damaged line is reported, not silently dropped to pretend the
        // history is intact; the valid entries still replay.
        unreadable = true;
      }
    }
    return { entries, unreadable };
  }

  function submit({ spaceId, recordId, signal, note = '', source = null, createdAt = new Date().toISOString() }) {
    assertId(spaceId, 'spaceId');
    if (!isIdLike(recordId)) throw invalid('feedback requires a valid target recordId.');
    if (!FEEDBACK_SIGNALS.includes(signal)) {
      throw invalid(`signal must be one of: ${FEEDBACK_SIGNALS.join(', ')}.`);
    }
    const trimmedNote = String(note ?? '').trim();
    if (trimmedNote.length > MAX_NOTE) throw invalid(`note must be at most ${MAX_NOTE} characters.`);
    const entry = {
      type: 'feedback',
      feedbackId: `fb-${randomUUID()}`,
      spaceId,
      recordId,
      signal,
      note: trimmedNote,
      source: source && typeof source === 'object' ? source : { kind: 'unknown' },
      createdAt
    };
    append(spaceId, entry);
    return entry;
  }

  function resolve({ spaceId, feedbackId, resolution, by = 'user', at = new Date().toISOString() }) {
    assertId(spaceId, 'spaceId');
    if (!isIdLike(feedbackId)) throw invalid('resolve requires a valid feedbackId.');
    if (!FEEDBACK_RESOLUTIONS.includes(resolution)) {
      throw invalid(`resolution must be one of: ${FEEDBACK_RESOLUTIONS.join(', ')}.`);
    }
    const { entries } = readLog(spaceId);
    if (!entries.some((e) => e.type === 'feedback' && e.feedbackId === feedbackId)) {
      throw invalid(`No such feedback: ${feedbackId}`, 'ATLAS_FEEDBACK_NOT_FOUND');
    }
    const entry = { type: 'resolution', feedbackId, resolution, by: String(by), at };
    append(spaceId, entry);
    return entry;
  }

  /** Replay the log into current feedback state. Newest first. */
  function list(spaceId, { status = 'pending' } = {}) {
    assertId(spaceId, 'spaceId');
    const { entries, unreadable } = readLog(spaceId);
    const byId = new Map();
    for (const e of entries) {
      if (e.type === 'feedback' && e.feedbackId) {
        byId.set(e.feedbackId, { ...e, resolution: null, resolvedBy: null, resolvedAt: null });
      }
    }
    for (const e of entries) {
      if (e.type === 'resolution' && byId.has(e.feedbackId)) {
        const target = byId.get(e.feedbackId);
        target.resolution = e.resolution;
        target.resolvedBy = e.by ?? null;
        target.resolvedAt = e.at ?? null;
      }
    }
    let rows = [...byId.values()];
    if (status === 'pending') rows = rows.filter((r) => r.resolution === null);
    else if (status !== 'all') rows = rows.filter((r) => r.resolution === status);
    rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { spaceId, status, feedback: rows, unreadable };
  }

  return { submit, resolve, list };
}
