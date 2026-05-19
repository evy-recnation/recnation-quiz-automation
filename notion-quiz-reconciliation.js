#!/usr/bin/env node
/**
 * notion-quiz-reconciliation.js
 *
 * Discovers all active quizzes from the Answer Keys database, scans every
 * response database for submissions, cross-references both trackers, and
 * prints a five-section reconciliation report.
 *
 * Usage:
 *   NOTION_TOKEN=secret_... node notion-quiz-reconciliation.js
 */

'use strict';

const https = require('https');

// ─── Config ──────────────────────────────────────────────────────────────────

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) {
  console.error('ERROR: Set NOTION_TOKEN environment variable before running.');
  process.exit(1);
}

const ANSWER_KEYS_DB     = '3338e709-96c7-809a-9e6f-fc9d18bf14b7';
const FSM_TRACKER_DB     = '41f5edc5-8ddd-4522-9057-70f445e9f3fb';
const FOCUSED_TRACKER_DB = 'e308e709-96c7-838e-a50b-8194b02e9a40';

const UNRENTABLE_KEYWORD = 'unrentable';

// Name property candidates (tried in order)
const NAME_PROPS = [
  'Name',
  'First & Last Name',
  'First and Last Name: ',
  'Q1 First Last Name',
];

// Block types that indicate grader-written feedback
const FEEDBACK_BLOCK_TYPES = new Set([
  'paragraph', 'callout', 'quote',
  'heading_1', 'heading_2', 'heading_3',
  'bulleted_list_item', 'numbered_list_item', 'to_do',
]);

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.notion.com',
      port: 443,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`Notion API ${res.statusCode}: ${JSON.stringify(json)}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`JSON parse error: ${data}`));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const get  = (path)       => request('GET',  `/v1/${path}`, null);
const post = (path, body) => request('POST', `/v1/${path}`, body);

// ─── Page-title cache ─────────────────────────────────────────────────────────

const _titleCache = new Map();

async function resolvePageTitle(pageId) {
  if (_titleCache.has(pageId)) return _titleCache.get(pageId);
  try {
    const page = await get(`pages/${pageId}`);
    const title = getTitle(page.properties) || '(untitled)';
    _titleCache.set(pageId, title);
    return title;
  } catch {
    _titleCache.set(pageId, '');
    return '';
  }
}

// ─── Pagination helpers ───────────────────────────────────────────────────────

async function getAllBlocks(pageId) {
  const blocks = [];
  let cursor;
  do {
    const params = cursor ? `?start_cursor=${cursor}` : '';
    const res = await get(`blocks/${pageId}/children${params}`);
    blocks.push(...(res.results || []));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

async function getAllRows(dbId) {
  const rows = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await post(`databases/${dbId}/query`, body);
    rows.push(...(res.results || []));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return rows;
}

// ─── Property extractors ──────────────────────────────────────────────────────

function getTitle(props) {
  for (const key of Object.keys(props)) {
    const p = props[key];
    if (p.type === 'title' && p.title && p.title.length > 0) {
      return p.title.map((t) => t.plain_text).join('').trim();
    }
  }
  return '';
}

function getPersonName(props) {
  for (const candidate of NAME_PROPS) {
    const p = props[candidate];
    if (!p) continue;
    if (p.type === 'title'      && p.title     && p.title.length     > 0)
      return p.title.map((t) => t.plain_text).join('').trim();
    if (p.type === 'rich_text'  && p.rich_text && p.rich_text.length > 0)
      return p.rich_text.map((t) => t.plain_text).join('').trim();
  }
  return '(unknown)';
}

function getDate(props, createdTime) {
  for (const key of ['Submission Date', 'Date', 'Created Time', 'Created']) {
    const p = props[key];
    if (!p) continue;
    if (p.type === 'date'         && p.date)         return p.date.start;
    if (p.type === 'created_time' && p.created_time) return p.created_time.slice(0, 10);
  }
  return createdTime ? createdTime.slice(0, 10) : '?';
}

function isTeamsMessageFilled(props) {
  const p = props['Teams Message'];
  if (!p) return false;
  if (p.type === 'rich_text') return p.rich_text && p.rich_text.length > 0;
  if (p.type === 'url')       return !!p.url;
  if (p.type === 'email')     return !!p.email;
  return false;
}

function isResultsSentViaTeams(props) {
  const p = props['Results Sent via Teams'];
  if (!p) return false;
  return p.type === 'checkbox' && p.checkbox === true;
}

function pageUrl(pageId) {
  return `https://www.notion.so/${pageId.replace(/-/g, '')}`;
}

function norm(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Core phrase: strip trailing boilerplate so "Making Units Unrentable: Full Process..."
// and "Making Units Unrentable" both reduce to the same lead phrase.
function corePhrase(s) {
  return norm(s)
    .replace(/[–—\-:]/g, ' ')   // dashes and colons → space
    .replace(/\s{2,}/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 5)                 // first 5 words is enough to disambiguate
    .join(' ');
}

// ─── Step 1: Discover all quizzes ────────────────────────────────────────────

async function discoverQuizzes() {
  console.log('Step 1 — Querying Answer Keys database…');
  const rows = await getAllRows(ANSWER_KEYS_DB);
  console.log(`  Found ${rows.length} answer key row(s).`);

  const quizzes = [];
  for (const row of rows) {
    const quizName = getTitle(row.properties);
    const pageId   = row.id;
    let responseDatabaseId = null;
    try {
      const blocks = await getAllBlocks(pageId);
      const childDb = blocks.find((b) => b.type === 'child_database');
      if (childDb) responseDatabaseId = childDb.id;
    } catch (e) {
      console.warn(`  Warning: could not read blocks for "${quizName}": ${e.message}`);
    }
    quizzes.push({ quizName, pageId, responseDatabaseId });
  }
  return quizzes;
}

// ─── Step 2: Scan response databases ─────────────────────────────────────────

async function scanResponses(quizzes) {
  console.log('\nStep 2 — Scanning response databases…');
  const submissions = [];

  for (const { quizName, responseDatabaseId } of quizzes) {
    if (!responseDatabaseId) {
      console.log(`  [SKIP] "${quizName}" — no child_database found`);
      continue;
    }
    let rows;
    try {
      rows = await getAllRows(responseDatabaseId);
    } catch (e) {
      console.warn(`  Warning: could not query response DB for "${quizName}": ${e.message}`);
      continue;
    }
    console.log(`  "${quizName}": ${rows.length} submission(s)`);
    for (const row of rows) {
      const name        = getPersonName(row.properties);
      const date        = getDate(row.properties, row.created_time);
      const teamsMsg    = isTeamsMessageFilled(row.properties);
      const resultsSent = isResultsSentViaTeams(row.properties);
      const url         = pageUrl(row.id);
      submissions.push({
        quizName, name, date, teamsMsg, resultsSent, url,
        pageId: row.id,
        hasFeedback: null,   // filled in Step 2b for ungraded Unrentable rows
      });
    }
  }
  return submissions;
}

// ─── Step 2b: Check page bodies of ungraded Unrentable submissions ────────────

/**
 * Returns true if the page body contains at least one non-empty text block —
 * indicating a grader wrote feedback before the Teams Message workflow existed.
 */
async function checkFeedbackContent(pageId) {
  try {
    const blocks = await getAllBlocks(pageId);
    for (const block of blocks) {
      if (!FEEDBACK_BLOCK_TYPES.has(block.type)) continue;
      const rt = block[block.type]?.rich_text;
      if (rt && rt.length > 0 && rt.some((t) => t.plain_text.trim())) return true;
    }
  } catch {
    // If we can't read the page, assume no feedback
  }
  return false;
}

async function enrichUnrentableFeedback(submissions) {
  const targets = submissions.filter(
    (s) => !s.teamsMsg && norm(s.quizName).includes(UNRENTABLE_KEYWORD)
  );
  if (targets.length === 0) return;
  console.log(`\nStep 2b — Checking page bodies of ${targets.length} ungraded Unrentable submission(s)…`);

  // Fetch in batches of 5 to avoid hammering the API
  for (let i = 0; i < targets.length; i += 5) {
    const batch = targets.slice(i, i + 5);
    const results = await Promise.all(batch.map((s) => checkFeedbackContent(s.pageId)));
    batch.forEach((s, idx) => { s.hasFeedback = results[idx]; });
    process.stdout.write(`  ${Math.min(i + 5, targets.length)}/${targets.length}\r`);
  }
  console.log(`  Done.                   `);
}

// ─── Step 3: Query trackers with relation resolution ─────────────────────────

/**
 * Returns an array of { fsmName, quizTitle } objects for tracker rows that
 * have a completion date.  Quiz relations are resolved to page titles.
 */
async function queryTracker(dbId, label) {
  console.log(`  Querying ${label}…`);
  let rows;
  try {
    rows = await getAllRows(dbId);
  } catch (e) {
    console.warn(`  Warning: could not query ${label}: ${e.message}`);
    return [];
  }
  console.log(`    ${rows.length} row(s)`);

  const entries = [];
  for (const row of rows) {
    const props = row.properties;

    // Person / FSM name
    let fsmName = getTitle(props);
    if (!fsmName) fsmName = getPersonName(props);

    // Completion date check
    let hasDate = false;
    for (const key of Object.keys(props)) {
      const p = props[key];
      if (p.type === 'date' && p.date) { hasDate = true; break; }
      if (p.type === 'created_time' && p.created_time) { /* don't treat auto-created_time as completion */ }
    }
    if (!hasDate) continue;

    // Resolve quiz title — check common property names
    let quizTitle = '';
    for (const key of ['Quiz', 'Quiz Name', 'Topic', 'Knowledge Article', 'Course']) {
      const p = props[key];
      if (!p) continue;
      if (p.type === 'select' && p.select) {
        quizTitle = p.select.name; break;
      }
      if (p.type === 'title' && p.title && p.title.length > 0) {
        quizTitle = p.title.map((t) => t.plain_text).join('').trim(); break;
      }
      if (p.type === 'rich_text' && p.rich_text && p.rich_text.length > 0) {
        quizTitle = p.rich_text.map((t) => t.plain_text).join('').trim(); break;
      }
      if (p.type === 'relation' && p.relation && p.relation.length > 0) {
        // Resolve the first related page to its title
        quizTitle = await resolvePageTitle(p.relation[0].id);
        break;
      }
    }

    entries.push({ fsmName: norm(fsmName), quizTitle: norm(quizTitle) });
  }
  return entries;
}

/**
 * Returns true when a submission is found in the combined tracker entries.
 * Matching strategy (in order):
 *   1. Exact norm(name) + exact norm(quizTitle)
 *   2. Exact norm(name) + corePhrase overlap (handles title variations)
 */
function inTracker(submission, trackerEntries) {
  const sName  = norm(submission.name);
  const sQuiz  = norm(submission.quizName);
  const sCore  = corePhrase(submission.quizName);

  for (const entry of trackerEntries) {
    if (entry.fsmName !== sName) continue;
    if (entry.quizTitle === sQuiz)               return true;
    if (corePhrase(entry.quizTitle) === sCore)   return true;
    // substring overlap — one title contains the other
    if (sQuiz.includes(entry.quizTitle) || entry.quizTitle.includes(sQuiz)) return true;
  }
  return false;
}

// ─── Step 4: Build & print report ────────────────────────────────────────────

function pad(s, n) {
  const str = String(s ?? '');
  return str.length >= n ? str : str + ' '.repeat(n - str.length);
}

function printReport(submissions, trackerEntries) {
  const needsGrading  = submissions.filter((s) => !s.teamsMsg);
  const gradedNotSent = submissions.filter((s) => s.teamsMsg && !s.resultsSent);
  const trackerGaps   = submissions.filter((s) => !inTracker(s, trackerEntries));

  // Split ungraded Unrentable into pre-reviewed vs truly blank
  const unrentableUngraded = needsGrading.filter((s) =>
    norm(s.quizName).includes(UNRENTABLE_KEYWORD)
  );
  const preReviewed  = unrentableUngraded.filter((s) => s.hasFeedback === true);
  const trulyBlank   = unrentableUngraded.filter((s) => s.hasFeedback !== true);
  const otherUngraded = needsGrading.filter((s) =>
    !norm(s.quizName).includes(UNRENTABLE_KEYWORD)
  );

  const line = '─'.repeat(115);
  const HDR  = `   ${pad('Quiz / Name', 62)} ${pad('Submitted', 12)} URL`;
  const DIV  = '   ' + '─'.repeat(112);

  function row(s, tag) {
    const label = tag ? `${s.name} [${tag}]` : s.name;
    return `   ${pad(s.quizName, 35)} ${pad(label, 28)} ${pad(s.date, 12)} ${s.url}`;
  }

  // ── A ─────────────────────────────────────────────────────────────────────
  console.log('\n' + line);
  console.log('A) NEEDS GRADING — Teams Message is empty');
  console.log(line);

  if (needsGrading.length === 0) {
    console.log('   (none)');
  } else {
    // A1: other quizzes
    if (otherUngraded.length > 0) {
      console.log('\n   ── Other quizzes ──');
      console.log(HDR); console.log(DIV);
      for (const s of otherUngraded) console.log(row(s));
    }

    // A2: Unrentable — pre-reviewed (manual feedback found in page body)
    if (preReviewed.length > 0) {
      console.log(`\n   ── Making Units Unrentable: ALREADY REVIEWED (manual feedback on page, no Teams msg) [${preReviewed.length}] ──`);
      console.log(HDR); console.log(DIV);
      for (const s of preReviewed) console.log(row(s, 'HAS FEEDBACK'));
    }

    // A3: Unrentable — truly blank
    if (trulyBlank.length > 0) {
      console.log(`\n   ── Making Units Unrentable: TRULY BLANK — need grading [${trulyBlank.length}] ──`);
      console.log(HDR); console.log(DIV);
      for (const s of trulyBlank) console.log(row(s, 'BLANK'));
    }
  }

  // ── B ─────────────────────────────────────────────────────────────────────
  console.log('\n' + line);
  console.log('B) GRADED BUT NOT SENT — Teams Message filled, Results Sent via Teams = false');
  console.log(line);
  if (gradedNotSent.length === 0) {
    console.log('   (none)');
  } else {
    console.log(HDR); console.log(DIV);
    for (const s of gradedNotSent) console.log(row(s));
  }

  // ── C ─────────────────────────────────────────────────────────────────────
  console.log('\n' + line);
  console.log('C) TRACKER GAPS — submission exists but not found in either tracker');
  console.log(line);
  if (trackerGaps.length === 0) {
    console.log('   (none — all submissions matched!)');
  } else {
    console.log(HDR); console.log(DIV);
    for (const s of trackerGaps) {
      console.log(`   ${pad(s.quizName, 35)} ${pad(s.name, 28)} ${pad(s.date, 12)} Missing from tracker`);
    }
  }

  // ── D ─────────────────────────────────────────────────────────────────────
  console.log('\n' + line);
  console.log('D) SUMMARY');
  console.log(line);

  const byQuiz = {};
  for (const s of submissions) {
    if (!byQuiz[s.quizName]) byQuiz[s.quizName] = { total: 0, complete: 0 };
    byQuiz[s.quizName].total++;
    if (s.teamsMsg && s.resultsSent && inTracker(s, trackerEntries))
      byQuiz[s.quizName].complete++;
  }

  console.log(`   ${pad('Quiz Name', 50)} ${pad('Total', 8)} ${pad('Fully Complete', 16)} Tracker Gaps`);
  console.log('   ' + '─'.repeat(90));
  let grandTotal = 0, grandComplete = 0, grandGaps = 0;
  for (const [quiz, { total, complete }] of Object.entries(byQuiz).sort()) {
    const gaps = trackerGaps.filter((s) => s.quizName === quiz).length;
    console.log(`   ${pad(quiz, 50)} ${pad(total, 8)} ${pad(complete, 16)} ${gaps}`);
    grandTotal    += total;
    grandComplete += complete;
    grandGaps     += gaps;
  }
  console.log('   ' + '─'.repeat(90));
  console.log(`   ${pad('TOTAL', 50)} ${pad(grandTotal, 8)} ${pad(grandComplete, 16)} ${grandGaps}`);
  console.log('\n   "Fully Complete" = Teams Message filled + Results Sent via Teams ✓ + in tracker\n');

  // ── E: Unrentable deep-dive ───────────────────────────────────────────────
  if (unrentableUngraded.length > 0) {
    console.log(line);
    console.log('E) UNRENTABLE DEEP-DIVE');
    console.log(line);
    console.log(`   Total ungraded Unrentable submissions: ${unrentableUngraded.length}`);
    console.log(`   Already reviewed (feedback on page):   ${preReviewed.length}`);
    console.log(`   Truly blank (need grading now):        ${trulyBlank.length}`);
    if (preReviewed.length > 0) {
      console.log('\n   Pre-reviewed — send Teams message to close out:');
      for (const s of preReviewed)
        console.log(`     ${pad(s.name, 30)} submitted ${s.date}  ${s.url}`);
    }
    if (trulyBlank.length > 0) {
      console.log('\n   Truly blank — need fresh grading:');
      for (const s of trulyBlank)
        console.log(`     ${pad(s.name, 30)} submitted ${s.date}  ${s.url}`);
    }
    console.log('');
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  try {
    console.log('='.repeat(60));
    console.log('Notion Quiz Reconciliation Report');
    console.log(`Run date: ${new Date().toISOString()}`);
    console.log('='.repeat(60));

    const quizzes     = await discoverQuizzes();
    const submissions = await scanResponses(quizzes);

    await enrichUnrentableFeedback(submissions);

    console.log(`\nStep 3 — Querying trackers (resolving relations)…`);
    const [fsmEntries, focusedEntries] = await Promise.all([
      queryTracker(FSM_TRACKER_DB,     'FSM Completed Quiz Tracker'),
      queryTracker(FOCUSED_TRACKER_DB, 'Quiz Focused Tracker'),
    ]);
    const allTrackerEntries = [...fsmEntries, ...focusedEntries];
    console.log(`  Combined tracker entries with completion dates: ${allTrackerEntries.length}`);

    console.log('\nStep 4 — Building report…');
    printReport(submissions, allTrackerEntries);

  } catch (err) {
    console.error('\nFATAL ERROR:', err.message);
    process.exit(1);
  }
})();
