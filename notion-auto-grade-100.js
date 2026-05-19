#!/usr/bin/env node
/**
 * notion-auto-grade-100.js
 *
 * Finds all quiz submission pages in the configured Notion database
 * and sets their grade property to 100.
 *
 * Required env vars:
 *   NOTION_TOKEN      – Notion integration token
 *   NOTION_DATABASE_ID – ID of the quiz-submissions database
 *
 * Optional env vars:
 *   GRADE_PROPERTY    – Name of the grade property (default: "Grade")
 *   DRY_RUN           – Set to "true" to preview without writing (default: false)
 */

const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const GRADE_PROPERTY = process.env.GRADE_PROPERTY || "Grade";
const DRY_RUN = process.env.DRY_RUN === "true";

if (!DATABASE_ID) {
  console.error("Error: NOTION_DATABASE_ID environment variable is required.");
  process.exit(1);
}

async function fetchAllPages() {
  const pages = [];
  let cursor;

  do {
    const response = await notion.databases.query({
      database_id: DATABASE_ID,
      start_cursor: cursor,
    });
    pages.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return pages;
}

async function gradePageTo100(page) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would grade page ${page.id}`);
    return;
  }

  await notion.pages.update({
    page_id: page.id,
    properties: {
      [GRADE_PROPERTY]: { number: 100 },
    },
  });

  console.log(`Graded page ${page.id} → 100`);
}

async function main() {
  console.log(`Fetching submissions from database ${DATABASE_ID}…`);
  const pages = await fetchAllPages();
  console.log(`Found ${pages.length} submission(s). ${DRY_RUN ? "(DRY RUN)" : ""}`);

  for (const page of pages) {
    await gradePageTo100(page);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
