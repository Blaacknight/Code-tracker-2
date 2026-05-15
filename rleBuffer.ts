/**
 * rleBuffer.ts
 *
 * Run-Length Encoded attribution buffer.
 *
 * Every character in a document is tagged H (human), L (LLM), or C (comment).
 * Instead of storing one tag per character we store compressed runs:
 *
 *   [{ tag:'H', len:10 }, { tag:'L', len:50 }, { tag:'H', len:5 }]
 *   = 10 human chars, then 50 LLM chars, then 5 human chars
 *
 * The buffer must stay in perfect sync with the document at all times.
 * applyChange() mirrors TextDocumentContentChangeEvent exactly.
 *
 * ── Common error sources (all handled here) ──────────────────────────────────
 *
 *  1. Off-by-one in delete: using < instead of <= when finding run boundaries
 *  2. Insert at exact end of a run: falling through without inserting
 *  3. Insert at offset 0: first run never gets the split-before path
 *  4. Delete spanning multiple runs: partial runs at boundaries incorrectly kept
 *  5. Zero-length runs not pruned: accumulate and cause wrong counts
 *  6. Merge not called after every operation: adjacent same-tag runs build up
 *  7. totalLength not updated after replace (delete + insert combo)
 *  8. Multi-cursor: changes applied top-to-bottom shift later offsets
 */

export type Tag = 'H' | 'L' | 'C';

export interface Run {
  tag: Tag;
  len: number;
  t:   number; // Date.now() when created — for retroactive reclassification
}

// ── Internal cursor used during walks ─────────────────────────────────────────

interface Pos {
  runIdx:    number; // which run we are in
  runOffset: number; // how many chars into that run
  docOffset: number; // absolute document position at start of this run
}

// ─────────────────────────────────────────────────────────────────────────────

export class RLEBuffer {

  private runs: Run[] = [];
  private _len = 0;

  get length(): number { return this._len; }

  // ── Initialize ───────────────────────────────────────────────────────────────

  /**
   * Set up a fresh buffer for a document we haven't seen before.
   * All existing content is tagged with defaultTag (usually 'H').
   */
  init(docLen: number, defaultTag: Tag = 'H', t = Date.now()): void {
    this.runs = docLen > 0 ? [{ tag: defaultTag, len: docLen, t }] : [];
    this._len  = docLen;
  }

  // ── Apply a VS Code content change ───────────────────────────────────────────

  /**
   * Mirrors one TextDocumentContentChangeEvent entry.
   *
   * @param offset  change.rangeOffset
   * @param delLen  change.rangeLength   (0 for pure insertion)
   * @param insText change.text          ('' for pure deletion)
   * @param tag     who made this change
   * @param t       Date.now() captured at the top of the event handler
   */
  applyChange(offset: number, delLen: number, insText: string, tag: Tag, t: number): void {
    // Validate — paranoid but catches upstream bugs immediately
    if (offset < 0)              throw new Error(`RLE: negative offset ${offset}`);
    if (offset > this._len)      throw new Error(`RLE: offset ${offset} > length ${this._len}`);
    if (delLen < 0)              throw new Error(`RLE: negative delLen ${delLen}`);
    if (offset + delLen > this._len)
      throw new Error(`RLE: delete end ${offset + delLen} > length ${this._len}`);

    if (delLen  > 0) this._delete(offset, delLen);
    if (insText.length > 0) this._insert(offset, insText.length, tag, t);

    this._len = this._len - delLen + insText.length;

    // Invariant check — catches bugs immediately during development
    // Remove in production if performance matters
    const actual = this.runs.reduce((s, r) => s + r.len, 0);
    if (actual !== this._len) {
      throw new Error(
        `RLE invariant broken: runs sum to ${actual} but _len is ${this._len}`
      );
    }
  }

  /**
   * Convenience: apply multiple changes from one event.
   * MUST be sorted descending by rangeOffset before calling
   * (so earlier offsets are not shifted by later changes).
   */
  applyChanges(
    changes: Array<{ rangeOffset: number; rangeLength: number; text: string }>,
    tag: Tag,
    t:   number
  ): void {
    // Sort descending — process bottom of file first
    const sorted = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
    for (const c of sorted) {
      this.applyChange(c.rangeOffset, c.rangeLength, c.text, tag, t);
    }
  }

  // ── Count ─────────────────────────────────────────────────────────────────────

  count(): Record<Tag, number> {
    const r: Record<Tag, number> = { H: 0, L: 0, C: 0 };
    for (const run of this.runs) r[run.tag] += run.len;
    return r;
  }

  // ── Get runs with absolute offsets (for decorations) ─────────────────────────

  runsWithOffsets(): Array<{ tag: Tag; start: number; end: number; t: number }> {
    const out: Array<{ tag: Tag; start: number; end: number; t: number }> = [];
    let pos = 0;
    for (const run of this.runs) {
      out.push({ tag: run.tag, start: pos, end: pos + run.len, t: run.t });
      pos += run.len;
    }
    return out;
  }

  // ── Retroactive reclassification ──────────────────────────────────────────────

  /**
   * Flip H→L for any run whose creation timestamp falls inside an LLM window.
   * Only flips runs with len > 2 (short runs = human keystrokes during window).
   * Returns true if anything changed.
   */
  reclassify(
    windows: Array<{ startTime: number; endTime: number }>,
    _filePath?: string // kept for API compat, unused here
  ): boolean {
    let changed = false;
    for (const run of this.runs) {
      if (run.tag !== 'H') continue;
      if (run.len <= 2)    continue;
      for (const w of windows) {
        if (run.t >= w.startTime && run.t <= w.endTime) {
          run.tag = 'L';
          changed  = true;
          break;
        }
      }
    }
    if (changed) this.runs = merge(this.runs);
    return changed;
  }

  // ── Serialization ─────────────────────────────────────────────────────────────

  serialize(): Run[] {
    return this.runs.map(r => ({ ...r }));
  }

  restore(runs: Run[]): void {
    this.runs = runs.map(r => ({ ...r }));
    this._len  = this.runs.reduce((s, r) => s + r.len, 0);
  }

  clone(): RLEBuffer {
    const b = new RLEBuffer();
    b.restore(this.serialize());
    return b;
  }

  static fromRuns(runs: Run[]): RLEBuffer {
    const b = new RLEBuffer();
    b.restore(runs);
    return b;
  }

  // ── DEBUG ─────────────────────────────────────────────────────────────────────

  /** Human-readable representation — useful in tests */
  toString(): string {
    return this.runs.map(r => `${r.tag}:${r.len}`).join(' | ');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // INTERNAL — DELETE
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Remove [offset, offset+len) from the run array.
   *
   * Walk through runs tracking absolute position.
   * For each run, figure out how much of it (if any) overlaps the deletion zone.
   * Keep the non-overlapping parts, discard the rest.
   */
  private _delete(offset: number, len: number): void {
    const delEnd = offset + len;
    const out:  Run[] = [];
    let   pos = 0; // absolute start position of current run

    for (const run of this.runs) {
      const runEnd = pos + run.len;

      if (runEnd <= offset) {
        // ── Run ends before deletion zone starts — keep entirely ────────────
        out.push({ ...run });

      } else if (pos >= delEnd) {
        // ── Run starts after deletion zone ends — keep entirely ─────────────
        out.push({ ...run });

      } else {
        // ── Run overlaps deletion zone — keep the parts outside it ──────────
        //
        //  Run:      [====|DDDDDDDD|=====]
        //                 ^        ^
        //               offset   delEnd
        //
        //  before: from pos    to offset  (= offset - pos chars)
        //  after:  from delEnd to runEnd  (= runEnd - delEnd chars)

        const beforeLen = offset - pos;         // chars before the deletion
        const afterLen  = runEnd - delEnd;       // chars after the deletion

        if (beforeLen > 0) {
          out.push({ tag: run.tag, len: beforeLen, t: run.t });
        }
        if (afterLen > 0) {
          out.push({ tag: run.tag, len: afterLen,  t: run.t });
        }
        // If both are 0 the run was entirely inside the deletion zone — discard
      }

      pos = runEnd;
    }

    this.runs = merge(out);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // INTERNAL — INSERT
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Insert a new run of (len, tag, t) at document position offset.
   *
   * Three cases for each existing run:
   *   A. Run ends before offset         → keep, continue
   *   B. Run starts at or after offset  → insert newRun first, then keep
   *   C. offset falls inside the run    → split: keep-before, newRun, keep-after
   *
   * Special case: offset === this._len (insert at very end of document)
   * Handled by the "not inserted yet" check after the loop.
   */
  private _insert(offset: number, len: number, tag: Tag, t: number): void {
    const newRun: Run = { tag, len, t };
    const out:    Run[] = [];
    let   pos      = 0;
    let   inserted = false;

    for (const run of this.runs) {
      const runEnd = pos + run.len;

      if (inserted) {
        // ── Already inserted — just copy remaining runs ──────────────────────
        out.push({ ...run });

      } else if (runEnd < offset) {
        // ── Case A: run ends strictly before offset — keep and move on ────────
        // Note: strictly < not <=  because if runEnd === offset we must insert
        // between this run and the next (handled in case B below).
        out.push({ ...run });

      } else if (pos === offset) {
        // ── Case B-start: run starts exactly at offset — insert before it ─────
        out.push({ ...newRun });
        out.push({ ...run });
        inserted = true;

      } else if (pos > offset) {
        // ── Case B-mid: run starts after offset — insert before it ────────────
        // (Should not normally happen since Case A/B-start should catch it,
        //  but handles the case where offset === 0 and first run starts at 0)
        out.push({ ...newRun });
        out.push({ ...run });
        inserted = true;

      } else if (runEnd === offset) {
        // ── Case B-end: run ends exactly at offset — keep run, insert after ───
        // This handles inserting at the boundary between two runs.
        // We insert AFTER this run (before the next), not inside it.
        out.push({ ...run });
        out.push({ ...newRun });
        inserted = true;

      } else {
        // ── Case C: offset falls strictly inside this run — split it ──────────
        //
        //  pos < offset < runEnd
        //
        //  Before: [run: pos..runEnd]
        //  After:  [run: pos..offset] [newRun: offset..offset+len] [run: offset..runEnd]

        const beforeLen = offset - pos;
        const afterLen  = runEnd  - offset;

        if (beforeLen > 0) out.push({ tag: run.tag, len: beforeLen, t: run.t });
        out.push({ ...newRun });
        if (afterLen  > 0) out.push({ tag: run.tag, len: afterLen,  t: run.t });
        inserted = true;
      }

      pos = runEnd;
    }

    // ── Insert at end of document (or into empty buffer) ──────────────────────
    if (!inserted) {
      out.push({ ...newRun });
    }

    this.runs = merge(out);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MERGE — collapse adjacent runs with the same tag
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge adjacent runs with the same tag.
 * Also prunes zero-length runs (these cause subtle count bugs if left in).
 *
 * Note: we do NOT merge by time — two L runs from different LLM calls
 * that happen to be adjacent should remain separate for reclassification.
 * We only merge by tag here.
 */
function merge(runs: Run[]): Run[] {
  const out: Run[] = [];

  for (const run of runs) {
    // Prune zero-length runs
    if (run.len <= 0) continue;

    const last = out[out.length - 1];

    if (last && last.tag === run.tag) {
      // Same tag — extend the last run
      // Keep the EARLIER timestamp (first write wins)
      last.len += run.len;
      if (run.t < last.t) last.t = run.t;
    } else {
      out.push({ ...run });
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS — run with: npx ts-node rleBuffer.ts
// Remove in production. Keep during development to catch regressions.
// ─────────────────────────────────────────────────────────────────────────────

function runTests(): void {
  let passed = 0;
  let failed = 0;

  function expect(label: string, actual: string, expected: string): void {
    if (actual === expected) {
      console.log(`  ✅ ${label}`);
      passed++;
    } else {
      console.error(`  ❌ ${label}`);
      console.error(`     expected: ${expected}`);
      console.error(`     actual:   ${actual}`);
      failed++;
    }
  }

  function expectLen(buf: RLEBuffer, expected: number): void {
    if (buf.length === expected) {
      console.log(`  ✅ length === ${expected}`);
      passed++;
    } else {
      console.error(`  ❌ length: expected ${expected}, got ${buf.length}`);
      failed++;
    }
  }

  const T = 1000; // fixed timestamp for tests

  // ── Test 1: Init ──────────────────────────────────────────────────────────
  console.log('\nTest 1: Init');
  {
    const b = new RLEBuffer();
    b.init(10, 'H', T);
    expect('single H run', b.toString(), 'H:10');
    expectLen(b, 10);
  }

  // ── Test 2: Insert at start ────────────────────────────────────────────────
  console.log('\nTest 2: Insert at start (offset=0)');
  {
    const b = new RLEBuffer();
    b.init(10, 'H', T);
    b.applyChange(0, 0, 'LLL', 'L', T); // insert 3 L chars at start
    expect('L then H', b.toString(), 'L:3 | H:10');
    expectLen(b, 13);
  }

  // ── Test 3: Insert at end ──────────────────────────────────────────────────
  console.log('\nTest 3: Insert at end');
  {
    const b = new RLEBuffer();
    b.init(10, 'H', T);
    b.applyChange(10, 0, 'LLL', 'L', T); // insert 3 L chars at end
    expect('H then L', b.toString(), 'H:10 | L:3');
    expectLen(b, 13);
  }

  // ── Test 4: Insert in middle ───────────────────────────────────────────────
  console.log('\nTest 4: Insert in middle');
  {
    const b = new RLEBuffer();
    b.init(10, 'H', T);
    b.applyChange(5, 0, 'LLL', 'L', T); // insert 3 L chars at offset 5
    expect('H:5 L:3 H:5', b.toString(), 'H:5 | L:3 | H:5');
    expectLen(b, 13);
  }

  // ── Test 5: Insert same tag merges ─────────────────────────────────────────
  console.log('\nTest 5: Insert same tag (should merge)');
  {
    const b = new RLEBuffer();
    b.init(10, 'H', T);
    b.applyChange(5, 0, 'HHH', 'H', T); // insert 3 H chars at offset 5
    expect('merged to H:13', b.toString(), 'H:13');
    expectLen(b, 13);
  }

  // ── Test 6: Delete entire buffer ──────────────────────────────────────────
  console.log('\nTest 6: Delete everything');
  {
    const b = new RLEBuffer();
    b.init(10, 'H', T);
    b.applyChange(0, 10, '', 'H', T);
    expect('empty', b.toString(), '');
    expectLen(b, 0);
  }

  // ── Test 7: Delete from start ──────────────────────────────────────────────
  console.log('\nTest 7: Delete from start');
  {
    const b = new RLEBuffer();
    b.init(10, 'H', T);
    b.applyChange(0, 3, '', 'H', T);
    expect('H:7', b.toString(), 'H:7');
    expectLen(b, 7);
  }

  // ── Test 8: Delete from end ────────────────────────────────────────────────
  console.log('\nTest 8: Delete from end');
  {
    const b = new RLEBuffer();
    b.init(10, 'H', T);
    b.applyChange(7, 3, '', 'H', T);
    expect('H:7', b.toString(), 'H:7');
    expectLen(b, 7);
  }

  // ── Test 9: Delete spanning multiple runs ──────────────────────────────────
  console.log('\nTest 9: Delete spanning multiple runs');
  {
    // H:5 L:5 H:5  →  delete offset=3, len=7  (removes last 2 of H, all of L, first 2 of H2)
    const b = new RLEBuffer();
    b.init(0, 'H', T);
    // Build: H:5 L:5 H:5
    b.applyChange(0, 0, 'HHHHH', 'H', T);
    b.applyChange(5, 0, 'LLLLL', 'L', T);
    b.applyChange(10, 0, 'HHHHH', 'H', T);
    expect('before delete', b.toString(), 'H:5 | L:5 | H:5');

    b.applyChange(3, 7, '', 'H', T);
    //  Kept: H:3 and H:3 (last 3 of second H block)
    expect('after delete', b.toString(), 'H:6');
    expectLen(b, 8);
  }

  // ── Test 10: Delete the LLM block ─────────────────────────────────────────
  console.log('\nTest 10: Delete middle LLM block');
  {
    const b = new RLEBuffer();
    b.init(0, 'H', T);
    b.applyChange(0, 0, 'HHHHH', 'H', T);  // H:5
    b.applyChange(5, 0, 'LLLLL', 'L', T);  // L:5
    b.applyChange(10, 0, 'HHHHH', 'H', T); // H:5

    b.applyChange(5, 5, '', 'H', T); // delete the L block
    expect('H:10', b.toString(), 'H:10');
    expectLen(b, 10);
  }

  // ── Test 11: Replace (delete + insert) ────────────────────────────────────
  console.log('\nTest 11: Replace — delete 3, insert 5');
  {
    const b = new RLEBuffer();
    b.init(10, 'H', T);
    b.applyChange(2, 3, 'LLLLL', 'L', T); // at offset 2, delete 3, insert 5 L
    expect('H:2 L:5 H:5', b.toString(), 'H:2 | L:5 | H:5');
    expectLen(b, 12);
  }

  // ── Test 12: Replace with same-tag (autocomplete) ─────────────────────────
  console.log('\nTest 12: Replace same tag (word completion: del 3 H, ins 8 H)');
  {
    const b = new RLEBuffer();
    b.init(10, 'H', T);
    b.applyChange(2, 3, 'HHHHHHHH', 'H', T); // del 3 H at 2, ins 8 H
    expect('merged H:15', b.toString(), 'H:15');
    expectLen(b, 15);
  }

  // ── Test 13: Insert at boundary between two runs ──────────────────────────
  console.log('\nTest 13: Insert at boundary between H and L runs');
  {
    const b = new RLEBuffer();
    b.init(0, 'H', T);
    b.applyChange(0, 0, 'HHHHH', 'H', T); // H:5
    b.applyChange(5, 0, 'LLLLL', 'L', T); // L:5
    // Insert H at offset 5 (boundary between H:5 and L:5)
    b.applyChange(5, 0, 'H', 'H', T);
    expect('H:6 L:5', b.toString(), 'H:6 | L:5');
    expectLen(b, 11);
  }

  // ── Test 14: Insert L at boundary ─────────────────────────────────────────
  console.log('\nTest 14: Insert L at boundary between H and L runs');
  {
    const b = new RLEBuffer();
    b.init(0, 'H', T);
    b.applyChange(0, 0, 'HHHHH', 'H', T); // H:5
    b.applyChange(5, 0, 'LLLLL', 'L', T); // L:5
    // Insert L at offset 5 (should merge with the L:5)
    b.applyChange(5, 0, 'LLL', 'L', T);
    expect('H:5 L:8', b.toString(), 'H:5 | L:8');
    expectLen(b, 13);
  }

  // ── Test 15: Empty buffer insert ──────────────────────────────────────────
  console.log('\nTest 15: Insert into empty buffer');
  {
    const b = new RLEBuffer();
    b.init(0, 'H', T);
    b.applyChange(0, 0, 'HELLO', 'H', T);
    expect('H:5', b.toString(), 'H:5');
    expectLen(b, 5);
  }

  // ── Test 16: Single char insert ───────────────────────────────────────────
  console.log('\nTest 16: Single char insert into middle of L run');
  {
    const b = new RLEBuffer();
    b.init(0, 'H', T);
    b.applyChange(0, 0, 'LLLLLLLLL', 'L', T); // L:9
    b.applyChange(4, 0, 'x', 'H', T);         // insert 1 H at position 4
    expect('L:4 H:1 L:5', b.toString(), 'L:4 | H:1 | L:5');
    expectLen(b, 10);
  }

  // ── Test 17: Simulate typing then undo ────────────────────────────────────
  console.log('\nTest 17: Serialize and restore (simulating undo snapshot)');
  {
    const b = new RLEBuffer();
    b.init(10, 'H', T);
    b.applyChange(5, 0, 'LLL', 'L', T);

    const snap = b.serialize(); // snapshot before next change
    b.applyChange(0, 3, '', 'H', T); // delete first 3 chars

    expect('after delete', b.toString(), 'H:2 | L:3 | H:5');

    b.restore(snap); // undo → restore snapshot
    expect('after restore', b.toString(), 'H:5 | L:3 | H:5');
    expectLen(b, 13);
  }

  // ── Test 18: Multi-cursor (two simultaneous inserts) ──────────────────────
  console.log('\nTest 18: Multi-cursor inserts (bottom-to-top order)');
  {
    const b = new RLEBuffer();
    b.init(20, 'H', T);

    // Two cursors: one at offset 15, one at offset 5
    // Must apply bottom-to-top (15 first, then 5)
    b.applyChanges(
      [
        { rangeOffset: 5,  rangeLength: 0, text: 'LLL' },
        { rangeOffset: 15, rangeLength: 0, text: 'LLL' },
      ],
      'L', T
    );

    // After applying offset=15 insert (3 chars): H:20→H:20+L:3 at pos 15
    // After applying offset=5 insert (3 chars):  splits H at 5
    expect('H:5 L:3 H:10 L:3 H:5', b.toString(), 'H:5 | L:3 | H:10 | L:3 | H:5');
    expectLen(b, 26);
  }

  // ── Test 19: Delete at offset 0 length 0 (no-op) ─────────────────────────
  console.log('\nTest 19: No-op change (empty insertion, zero deletion)');
  {
    const b = new RLEBuffer();
    b.init(10, 'H', T);
    b.applyChange(5, 0, '', 'H', T); // no-op
    expect('unchanged', b.toString(), 'H:10');
    expectLen(b, 10);
  }

  // ── Test 20: Large replace — LLM rewrites everything ─────────────────────
  console.log('\nTest 20: LLM rewrites entire file');
  {
    const b = new RLEBuffer();
    b.init(100, 'H', T);
    b.applyChange(0, 100, 'X'.repeat(200), 'L', T); // delete all, insert 200 L
    expect('L:200', b.toString(), 'L:200');
    expectLen(b, 200);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// Uncomment to run tests:
// runTests();
