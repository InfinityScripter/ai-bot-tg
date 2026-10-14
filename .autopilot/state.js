window.STATE =
{
  "version": 2,
  "slug": "digest-cover-style",
  "dir": "2026-10-14-digest-cover-style--wip",
  "title": "Обложки постов в стиле «Разработчица и шпИИц»",
  "mode": "full",
  "depth": "normal",
  "tier": "T0",
  "briefFile": "2026-10-14-brief.md",
  "memoryFile": "CLAUDE.md",
  "memoryOwner": "user",
  "skillDir": "/Users/kot/.claude/skills/autopilot",
  "baseCommit": null,
  "startedAt": "2026-10-14T21:02:58+03:00",
  "updatedAt": "2026-10-14T21:06:07+03:00",
  "finishedAt": null,
  "stages": [
    {
      "id": "preflight",
      "status": "done",
      "startedAt": "2026-10-14T21:02:58+03:00",
      "finishedAt": "2026-10-14T21:03:15+03:00"
    },
    {
      "id": "manifest",
      "status": "done",
      "startedAt": "2026-10-14T21:03:15+03:00",
      "finishedAt": "2026-10-14T21:04:27+03:00"
    },
    {
      "id": "briefing",
      "status": "skipped",
      "startedAt": "2026-10-14T21:04:22+03:00",
      "finishedAt": "2026-10-14T21:04:22+03:00",
      "note": "полный автомат — самобрифинг"
    },
    {
      "id": "spec",
      "status": "done",
      "startedAt": "2026-10-14T21:04:27+03:00",
      "finishedAt": "2026-10-14T21:05:48+03:00"
    },
    {
      "id": "plan",
      "status": "active",
      "startedAt": "2026-10-14T21:05:48+03:00"
    },
    {
      "id": "build",
      "status": "pending"
    },
    {
      "id": "review",
      "status": "pending"
    },
    {
      "id": "final",
      "status": "pending"
    }
  ],
  "requirements": {
    "total": 7,
    "done": 0,
    "inTicket": 6,
    "inSpec": 0,
    "placeholder": 0,
    "deferred": 1,
    "dropped": 0
  },
  "tickets": [
    {
      "id": "01",
      "title": "Обложка в стиле канала «Разработчица и шпИИц»",
      "requirements": [
        "R02",
        "R03",
        "R04",
        "R05",
        "R06i",
        "R07i"
      ],
      "blockedBy": [],
      "wave": 1,
      "zone": [
        "src/blog/renderCover.ts",
        "tests/render-cover.test.ts",
        "assets/brand/channel-avatar.jpg",
        "README.md"
      ],
      "review": "нет",
      "model": "обычная",
      "status": "pending",
      "retries": 0,
      "repairs": 0
    }
  ],
  "tests": null,
  "debt": {
    "placeholders": [],
    "assumptions": [
      "Новый стиль получают все обложки канала, не только дайджест — их рисует одна функция",
      "На обложку ставится текущая аватарка канала; сменится аватарка — файл заменить руками"
    ],
    "emptyEnv": []
  },
  "additions": [],
  "coverage": {
    "found": 4,
    "fixed": 4,
    "deferred": 0,
    "items": []
  },
  "concerns": [],
  "blind": null,
  "beats": [
    "2026-10-14T21:02:58+03:00",
    "2026-10-14T21:03:15+03:00",
    "2026-10-14T21:03:54+03:00",
    "2026-10-14T21:04:22+03:00",
    "2026-10-14T21:04:27+03:00",
    "2026-10-14T21:05:10+03:00",
    "2026-10-14T21:05:41+03:00",
    "2026-10-14T21:05:48+03:00",
    "2026-10-14T21:05:49+03:00",
    "2026-10-14T21:06:07+03:00"
  ],
  "rev": 12,
  "waiting": null,
  "waits": [],
  "log": [
    {
      "t": "2026-10-14T21:02:58+03:00",
      "k": "init"
    },
    {
      "t": "2026-10-14T21:03:15+03:00",
      "k": "stage",
      "id": "manifest",
      "act": "start"
    },
    {
      "t": "2026-10-14T21:04:22+03:00",
      "k": "stage",
      "id": "briefing",
      "act": "skip",
      "note": "полный автомат — самобрифинг"
    },
    {
      "t": "2026-10-14T21:04:27+03:00",
      "k": "gate",
      "g": "G1",
      "ok": false,
      "open": 6,
      "total": 7
    },
    {
      "t": "2026-10-14T21:04:27+03:00",
      "k": "stage",
      "id": "spec",
      "act": "start"
    },
    {
      "t": "2026-10-14T21:05:10+03:00",
      "k": "add",
      "key": "debt.assumptions",
      "n": 2
    },
    {
      "t": "2026-10-14T21:05:41+03:00",
      "k": "gate",
      "g": "G2",
      "ok": true,
      "found": 4,
      "fixed": 4,
      "deferred": 0
    },
    {
      "t": "2026-10-14T21:05:48+03:00",
      "k": "stage",
      "id": "plan",
      "act": "start"
    },
    {
      "t": "2026-10-14T21:05:49+03:00",
      "k": "tier",
      "v": "T0"
    },
    {
      "t": "2026-10-14T21:06:07+03:00",
      "k": "tickets",
      "n": 1
    },
    {
      "t": "2026-10-14T21:06:07+03:00",
      "k": "gate",
      "g": "G3",
      "ok": true,
      "problems": 0
    }
  ],
  "reqList": [
    {
      "id": "R01",
      "text": "«проверил на сайте, что ссылки ведут правильно на этот канал в Телеграме»",
      "status": "deferred",
      "why": "другой репозиторий (blog-app-mui-frontend); проверено до сборки: все ссылки ведут на t.me/sh0ny, а канал — t.me/ai_first_news; правится отдельно, вне этой сборки"
    },
    {
      "id": "R02",
      "text": "«Сейчас дайджесты просто выглядят таким серым экраном, и на них написан текст» — уйти от серого экрана с текстом",
      "status": "in-ticket"
    },
    {
      "id": "R03",
      "text": "«стилизовать его под канал разработчицы и шпиц»",
      "status": "in-ticket"
    },
    {
      "id": "R04",
      "text": "«чтобы он был более тематическим»",
      "status": "in-ticket"
    },
    {
      "id": "R05",
      "text": "«сначала поставить этот скилл и с помощью него прогнать в режиме full полностью автоматически»",
      "status": "in-ticket"
    },
    {
      "id": "R06i",
      "text": "(подразумевается) заголовок, дата и рубрика на обложке по-прежнему читаются и влезают",
      "status": "in-ticket"
    },
    {
      "id": "R07i",
      "text": "(подразумевается) обложка остаётся картинкой, которую бот рисует сам без сети и без падений: сбой рендера не роняет пост",
      "status": "in-ticket"
    }
  ],
  "gates": {
    "G1": {
      "ok": false,
      "at": "2026-10-14T21:04:27+03:00",
      "open": 6,
      "total": 7
    },
    "G2": {
      "ok": true,
      "at": "2026-10-14T21:05:41+03:00",
      "found": 4,
      "fixed": 4,
      "deferred": 0
    },
    "G3": {
      "ok": true,
      "at": "2026-10-14T21:06:07+03:00",
      "problems": 0
    }
  },
  "result": null
}
