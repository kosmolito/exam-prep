# Exam Prep App

A browser-based exam practice tool. Load any question set as a YAML or JSON file and practice in **Practice mode** (instant feedback) or **Exam mode** (timed, no per-question feedback).

## Quick start

### Docker (recommended)

#### Build

```bash
# Build the container
docker build . -t exam-prep
```

#### Run - Docker inline

```bash
docker run -p 8888:8888 -v ./my-exam:/questions exam-prep --input-file /questions/questions.yaml
```

#### Run - Docker Compose

```bash
# Default — loads the built-in sample questions
docker compose up

# Your own questions — uncomment and edit the volume/command in docker-compose.yaml first
docker compose up
```

Open **http://localhost:8888**

### Local (Python)

```bash
pip install -r app/requirements.txt
python app/serve.py                                   # sample questions
python app/serve.py --input-file my-exam/questions.yaml
```

## Project layout

```text
.
├── app/
│   ├── serve.py            # HTTP server — entry point
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── requirements.txt
│   └── sample-questions/   # Built-in demo questions
│       ├── questions.yaml
│       └── 6.png
├── Dockerfile
└── docker-compose.yaml
```

## Bringing your own questions

Create a YAML (or JSON) file following this structure:

```yaml
meta:
  title: "My Exam"
  description: "Optional subtitle"
  pass_mark: 80       # percentage required to pass
  time_limit: 90      # minutes for Exam mode (omit to hide Exam mode)

questions:
  - id: 1
    number: 1
    question: "What is X?"
    options:
      A: "First option"
      B: "Second option"
      C: "Third option"
      D: "Fourth option"
    correct_answers: ["B"]          # single-select
    explanation: "Because..."

  - id: 2
    number: 2
    question: "Which two statements are correct?"
    options:
      A: "..."
      B: "..."
      C: "..."
      D: "..."
    correct_answers: ["A", "C"]     # multi-select — shows "Choose 2." prompt
    explanation: "..."
```

**Images:** place `<question-number>.png` (or `.jpg`/`.jpeg`/`.webp`) in the same directory as the questions file. The server detects and serves them automatically.

## Features

| Feature | Details |
|---|---|
| Practice mode | Instant correct/wrong feedback + explanation per question |
| Exam mode | Countdown timer, no feedback until results screen |
| Session persistence | Unfinished sessions resume after browser/server restart |
| Bookmarks | Star any question; practice bookmarked set separately |
| Multi-select | `correct_answers` with 2+ entries enables checkbox-style selection |
| Back navigation | Go back to any previous question and update your answer |
| Image exhibits | Auto-detected by question number from the questions directory |
