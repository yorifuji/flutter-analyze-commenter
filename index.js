const fs = require('fs');

module.exports = async function ({
  core,
  github,
  context,
  workingDir,
  analyzeLog,
  verboseLogging,
  maxIssues,
  perPage
}) {
  function logVerbose(message) {
    if (verboseLogging) {
      console.log(message);
    }
  }

  function logError(error) {
    if (verboseLogging) {
      console.error('Error:', error);
    }
    core.setFailed(error);
  }

  class Issue {
    constructor(level, message, file, line, column) {
      this.level = level;
      this.message = message;
      this.file = file;
      this.line = line;
      this.column = column;
    }
  }

  class LocalComment {
    constructor(issue) {
      const levelIcon = {
        'info': 'ℹ️',
        'warning': '⚠️',
        'error': '❌'
      };
      this.path = issue.file;
      this.line = issue.line; // Ensure this is the correct line for the GitHub comment
      this.body = `<table><tr><td>${levelIcon[issue.level]}</td><td>${issue.message}</td></tr></table><!-- Flutter Analyze Commenter -->`;
    }
  }

  class RemoteComment {
    constructor(id, path, line, body) {
      this.id = id;
      this.path = path;
      this.line = line;
      this.body = body;
    }

    matchesLocalComment(localComment) {
      return this.path === localComment.path &&
        this.line === localComment.line &&
        this.body === localComment.body;
    }
  }

  function parseToIssues(analyzeLog) {
    const regex = /\[(info|warning|error)\] (.+) \((.+):(\d+):(\d+)\)/g;
    const issues = [];
    let match;
    while ((match = regex.exec(analyzeLog))) {
      issues.push(new Issue(
        match[1],
        match[2],
        convertFullPathToDiffPath(match[3], workingDir),
        parseInt(match[4], 10),
        parseInt(match[5], 10)
      ));
    }
    return issues;
  }

  function convertFullPathToDiffPath(fullPath) {
    return fullPath.replace(workingDir, '').replace(/^\//, '');
  }

  function generateLocalComments(diff, issues) {
    const diffLines = diff.split('\n');
    const localComments = [];

    let currentFile = '';
    let lineCounter = 0; // 全体の行番号を追跡

    for (const line of diffLines) {
      if (line.startsWith('---') || line.startsWith('+++')) {
        if (line.startsWith('+++')) {
          currentFile = line.replace('+++ b/', '');
        }
        lineCounter = 0; // 新しいファイルセクションで行番号をリセット
        continue;
      }

      // diffハンクのヘッダーを処理
      const hunkHeaderMatch = line.match(/^@@ -\d+,?\d* \+(\d+),?\d* @@/);
      if (hunkHeaderMatch) {
        lineCounter = parseInt(hunkHeaderMatch[1], 10) - 1;
        continue;
      }

      if (line.startsWith('+')) {
        // 変更された行に対して処理
        lineCounter++;
        const matchedResults = issues.filter(issue => issue.file === currentFile && issue.line === lineCounter);
        for (const result of matchedResults) {
          localComments.push(new LocalComment(result));
        }
      } else if (!line.startsWith('-')) {
        // その他の行（変更されていない行やハンクヘッダー）にも行番号をカウントアップ
        lineCounter++;
      }
    }

    return localComments;
  }

  async function run() {
    let issues;
    try {
      const analyzerOutput = fs.readFileSync(analyzeLog, 'utf-8');
      issues = parseToIssues(analyzerOutput);
      logVerbose(`Parsed issues: ${JSON.stringify(issues, null, 2)}`);
    } catch (error) {
      logError(`Failed to read analyze log: ${error.message}`);
      return;
    }

    const maxIssuesComment = '<!-- Flutter Analyze Commenter: maxIssues -->';
    // delete summary comment
    try {
      const listComments = await github.rest.issues.listComments({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.issue.number,
        per_page: perPage
      });
      const summaryComment = listComments.data.find(comment => comment.body.includes(maxIssuesComment));
      if (summaryComment) {
        await github.rest.issues.deleteComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          comment_id: summaryComment.id
        });
      }
    } catch (error) {
      logError(`Failed to delete summary comment: ${error.message}`);
      return;
    }

    if (issues.length > maxIssues) {
      // Create a summary comment
      const summary = `Flutter analyze commenter found ${issues.length} issues, which exceeds the maximum of ${maxIssues}.\n${maxIssuesComment}`;
      try {
        await github.rest.issues.createComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: context.issue.number,
          body: summary
        });
        logError(`Number of issues exceeds maximum: ${issues.length} > ${maxIssues}`);
        return;
      }
      catch (error) {
        logError(`Failed to create summary comment: ${error.message}`);
      }
    }

    let localComments;
    try {
      const diff = await github.rest.pulls.get({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: context.issue.number,
        mediaType: {
          format: "diff",
        }
      });
      logVerbose('Received diff from GitHub.');
      localComments = generateLocalComments(diff.data, issues);
      logVerbose(`Generated local comments: ${JSON.stringify(localComments, null, 2)}`);
    } catch (error) {
      logError(`Failed to create local comments: ${error.message}`);
      return;
    }

    let remoteComments;
    try {
      logVerbose('Retrieving remote comments.');
      const listReviewComments = await github.rest.pulls.listReviewComments({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: context.issue.number,
        per_page: perPage
      });
      // logVerbose(`listReviewComments result: ${JSON.stringify(listReviewComments.data, null, 2)}`);
      remoteComments = listReviewComments.data.map(comment =>
        new RemoteComment(comment.id, comment.path, comment.original_line || comment.line, comment.body)
      );
      logVerbose(`Existed remote comments: ${JSON.stringify(remoteComments, null, 2)}`);
    } catch (error) {
      logError(`Failed to parse remote comments: ${error.message}`);
      return;
    }

    // Logic to determine which comments to create, update, or delete
    const commentsToAdd = localComments.filter(local =>
      !remoteComments.some(remote => remote.matchesLocalComment(local))
    );
    const commentsToDelete = remoteComments.filter(remote =>
      !localComments.some(local => remote.matchesLocalComment(local))
    );

    // Add new comments to the PR
    for (const comment of commentsToAdd) {
      try {
        await github.rest.pulls.createReviewComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          pull_number: context.issue.number,
          commit_id: context.payload.pull_request.head.sha,
          path: comment.path,
          side: "RIGHT",
          line: comment.line,
          body: comment.body
        });
      } catch (error) {
        logError(`Failed to add comment: ${error.message}`);
      }
    }

    // Delete missing comments from the PR
    for (const comment of commentsToDelete) {
      try {
        await github.rest.pulls.deleteReviewComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          comment_id: comment.id
        });
      } catch (error) {
        logError(`Failed to delete comment: ${error.message}`);
      }
    }

    logVerbose('Processing completed.');
  }
  run();
}
