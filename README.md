# flutter-analyze-commenter

GitHub Action that automatically comments on pull requests with the results from Flutter Analyze.

## USAGE

```yaml
jobs:
  flutter-analyze:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write # required to add comment on PR
    steps:
      # checkout your repository and install flutter

      # run flutter analyze with --write option
      - name: Run flutter analyze
        run: flutter analyze --write=flutter_analyze.log

      # use flutter-analyze-commenter
      - name: Comment PR by flutter-analyze-commenter
        uses: yorifuji/flutter-analyze-commenter@v1
        if: always() # run this step even if flutter analyze fails
        with:
          analyze_log: flutter_analyze.log # file path of flutter analyze log
          verbose: true # optional: default is false
```

## How it works

TBD

## Known issues

# DEVELOPMENT

TBD

## Setup

TBD

## DEBUG

TBD

# LICENSE

MIT
