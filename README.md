# recnation-quiz-automation

Automation scripts for managing quiz submissions in Notion.

## Scripts

### `notion-auto-grade-100.js`

Sets the grade of every submission in a Notion quiz database to **100**.

#### Prerequisites

```
npm install @notionhq/client
```

#### Environment variables

| Variable | Required | Description |
|---|---|---|
| `NOTION_TOKEN` | Yes | Notion integration token |
| `NOTION_DATABASE_ID` | Yes | ID of the quiz-submissions database |
| `GRADE_PROPERTY` | No | Name of the grade property (default: `"Grade"`) |
| `DRY_RUN` | No | Set to `"true"` to preview without writing |

#### Usage

```bash
# Grade all submissions
NOTION_TOKEN=secret_xxx NOTION_DATABASE_ID=yyy node notion-auto-grade-100.js

# Preview without making changes
DRY_RUN=true NOTION_TOKEN=secret_xxx NOTION_DATABASE_ID=yyy node notion-auto-grade-100.js
```
