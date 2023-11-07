const fs = require('fs');

module.exports = async function ({ core, github, context }) {
  const analyzeLog = process.env.ANALYZE_LOG;
  const verboseLogging = process.env.VERBOSE === 'true';
  const workingDir = process.env.GITHUB_WORKSPACE; // /home/runner/...

  function logVerbose(message) {
    if (verboseLogging) {
      console.log(message);
    }
  }

  function logError(error) {
    console.error('Error:', error);
    if (verboseLogging) {
      console.error(error.stack);
    }
  }

  class Comment {
    constructor(id, path, position, body) {
      this.id = id;
      this.path = path;
      this.position = position;
      this.body = body;
    }

    static fromAnalyzerResult(result) {
      const level = result.level == 'info' ? 'ℹ️' : result.level == 'warning' ? '⚠️' : '❌';
      const body = `<table><tr><td>${level}</td><td>${result.message}</td></tr></table><!-- Flutter Analyze Commenter -->`;
      return new Comment(null, result.file, result.line, body);
    }

    matchesExistingComment(existingComment) {
      return this.path === existingComment.path &&
        this.position === existingComment.position &&
        this.body === existingComment.body;
    }
  }

  function parseAnalyzerOutput(output) {
    const regex = /\[(info|warning|error)\] (.+) \((.+):(\d+):(\d+)\)/g;
    const issues = [];
    let match;
    while (match = regex.exec(output)) {
      issues.push({
        level: match[1],
        message: match[2],
        file: match[3],
        line: parseInt(match[4]),
        column: parseInt(match[5])
      });
    }
    return issues;
  }

  function convertFullPathToDiffPath(fullPath) {
    return fullPath.replace(workingDir, '').replace(/^\//, '');
  }

  function generateReviewComments(diff, analyzerResults) {
    const diffLines = diff.split('\n');
    const comments = [];

    let currentFile = '';
    let oldLineCounter = 0; // ファイルの「元」の行番号を追跡
    let newLineCounter = 0; // ファイルの「新しい」行番号を追跡

    for (const line of diffLines) {
      if (line.startsWith('---') || line.startsWith('+++')) {
        // 新しいファイルセクションが始まるたびにカウンターをリセット
        if (line.startsWith('+++')) {
          currentFile = line.replace('+++ b/', '');
        }
        oldLineCounter = 0;
        newLineCounter = 0;
        continue;
      }

      // diffハンクのヘッダーを処理 (e.g., @@ -1,5 +1,6 @@)
      const hunkHeaderMatch = line.match(/^@@ -(\d+),?\d* \+(\d+),?\d* @@/);
      if (hunkHeaderMatch) {
        oldLineCounter = parseInt(hunkHeaderMatch[1], 10) - 1;
        newLineCounter = parseInt(hunkHeaderMatch[2], 10) - 1;
        continue;
      }

      if (line.startsWith('+')) {
        newLineCounter++;
        const matchedResults = analyzerResults.filter(result => result.file === currentFile && result.line === newLineCounter);
        for (const result of matchedResults) {
          comments.push(Comment.fromAnalyzerResult(result));
        }
      } else if (line.startsWith('-')) {
        oldLineCounter++;
      } else {
        oldLineCounter++;
        newLineCounter++;
      }
    }

    return comments;
  }


  async function run() {
    let analyzerResults;
    try {
      const analyzerOutput = fs.readFileSync(analyzeLog, 'utf-8');
      analyzerResults = parseAnalyzerOutput(analyzerOutput).map(result => {
        result.file = convertFullPathToDiffPath(result.file);
        return result;
      });
      logVerbose(`Parsed analyzer results: ${JSON.stringify(analyzerResults, null, 2)}`);
    } catch (error) {
      logError(error);
      core.setFailed(`Failed to read or parse analyze log: ${error.message}`);
      return;
    }

    let comments;
    try {
      const response = await github.rest.pulls.get({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: context.issue.number,
        mediaType: {
          format: "diff",
        }
      });
      logVerbose('Received diff from GitHub.');
      comments = generateReviewComments(response.data, analyzerResults);
      logVerbose(`Generated review comments: ${JSON.stringify(comments, null, 2)}`);
    } catch (error) {
      logError(error);
      core.setFailed(`Failed to generate review comments: ${error.message}`);
      return;
    }

    let existingComments;
    try {
      logVerbose('Retrieving existing review comments.');
      const listReviewComments = await github.rest.pulls.listReviewComments({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: context.issue.number
      });
      existingComments = listReviewComments.data.map(data => {
        return new Comment(data.id, data.path, data.original_position || data.position, data.body);
      });
      logVerbose(`Existed review comments: ${JSON.stringify(existingComments, null, 2)}`);
    } catch (error) {
      logError(error);
      core.setFailed(`Failed to retrive review comments: ${error.message}`);
      return;
    }

    const newComments = comments.filter(comment => !existingComments.some(existing => comment.matchesExistingComment(existing)));
    const missingComments = existingComments.filter(existing => !comments.some(comment => comment.matchesExistingComment(existing)));

    // new
    for (const comment of newComments) {
      await github.rest.pulls.createReviewComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: context.issue.number,
        commit_id: context.payload.pull_request.head.sha,
        path: comment.path,
        position: comment.position,
        body: comment.body
      });
    }

    // missing
    for (const comment of missingComments) {
      await github.rest.pulls.deleteReviewComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        comment_id: comment.id
      });
    }

    logVerbose('Review comments processing completed.');
  }

  run();
}
