const fs = require('fs');

module.exports = async function ({
  core,
  github,
  context,
  workingDir,
  analyzeLog,
  customLintLog,
  verboseLogging,
}) {

  const maxIssues = 10;
  const perPage = 100;

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

  logVerbose(`Working directory: ${workingDir}`);

  let issues;
  // parse flutter analyze log
  try {
    const analyzerOutput = fs.readFileSync(analyzeLog, 'utf-8');
    logVerbose(`Analyzer output: ${analyzerOutput}`);
    issues = parseAnalyzerOutputs(analyzerOutput, workingDir);
    logVerbose(`Parsed issues: ${JSON.stringify(issues, null, 2)}`);
  } catch (error) {
    logError(`Failed to read analyze log: ${error.message}`);
    return;
  }

  // parse custom lint log
  try {
    let customLintIssues = new CustomLintParser(customLintLog, workingDir).parse();
    logVerbose(`Parsed custom lint issues: ${JSON.stringify(customLintIssues, null, 2)}`);
    issues = issues.concat(customLintIssues);
  } catch (error) {
    logError(`Failed to read custom lint log: ${error.message}`);
    return;
  }

  const maxIssuesCommentHeader = '<!-- Flutter Analyze Commenter: maxIssues -->';
  // delete exist maxIssues comment
  try {
    const response = await github.rest.issues.listComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.issue.number,
      per_page: perPage
    });
    const maxIssuesComment = response.data.find(comment => comment.body.includes(maxIssuesCommentHeader));
    if (maxIssuesComment !== undefined) {
      await github.rest.issues.deleteComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        comment_id: maxIssuesComment.id
      });
    }
  } catch (error) {
    logError(`Failed to delete summary comment: ${error.message}`);
    return;
  }

  if (issues.length > maxIssues) {
    // Create maxIssues comment, and exit
    const body = `Flutter analyze commenter found ${issues.length} issues, which exceeds the maximum of ${maxIssues}.\n${maxIssuesCommentHeader}`;
    try {
      await github.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.issue.number,
        body: body
      });
      logVerbose(`Number of issues exceeds maximum: ${issues.length} > ${maxIssues}`);
      return;
    }
    catch (error) {
      logError(`Failed to create maxIssues comment: ${error.message}`);
      return;
    }
  }

  // Retrieve diff
  let diff;
  try {
    const response = await github.rest.pulls.get({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.issue.number,
      mediaType: {
        format: "diff",
      }
    });
    // logVerbose('Received diff from GitHub.');
    // logVerbose(response.data);
    diff = new Diff(response.data);
    logVerbose(`Diff: ${JSON.stringify(diff, null, 2)}`);
  } catch (error) {
    logError(`Failed to retrieve diff: ${error.message}`);
    return;
  }

  // Create inline comments and outline comment
  let inlineComments;
  let outlineComment;
  try {
    const { issuesInDiff, issuesNotInDiff } = filterIssuesByDiff(diff, issues);
    logVerbose(`Issues in Diff: ${JSON.stringify(issuesInDiff, null, 2)}`);
    logVerbose(`Issues not in Diff: ${JSON.stringify(issuesNotInDiff, null, 2)}`);

    const groupedIssues = groupIssuesByLine(issuesInDiff);
    inlineComments = groupedIssues.map(group => new Comment(group));
    logVerbose(`Inline comments: ${JSON.stringify(inlineComments, null, 2)}`);

    outlineComment = issuesNotInDiff.length > 0 ? generateTableForIssuesNotInDiff(issuesNotInDiff) : null;
    logVerbose(`Outline comment: ${outlineComment}`);
  } catch (error) {
    logError(`Failed to create inline comments: ${error.message}`);
    return;
  }

  // Delete outline comment
  try {
    const response = await github.rest.issues.listComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.issue.number,
      per_page: perPage
    });
    // logVerbose(`listComments results: ${JSON.stringify(response.data, null, 2)}`);
    const existOutlineComment = response.data.find(comment => comment.body.includes('<!-- Flutter Analyze Commenter: outline issues -->'));
    // logVerbose(`existOutlineComment: ${JSON.stringify(existOutlineComment, null, 2)}`);
    if (existOutlineComment !== undefined) {
      await github.rest.issues.deleteComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        comment_id: existOutlineComment.id
      });
    }
  } catch (error) {
    logError(`Failed to delete outline comment: ${error.message}`);
    return;
  }

  // Create outline comment
  if (outlineComment) {
    try {
      await github.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.issue.number,
        body: outlineComment
      });
    } catch (error) {
      logError(`Failed to create outline comment: ${error.message}`);
      return;
    }
  }

  // Retrieve existing comments
  let remoteComments;
  try {
    logVerbose('Retrieving remote comments.');
    const response = await github.rest.pulls.listReviewComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.issue.number,
      per_page: perPage
    });
    // logVerbose(`listReviewComments result: ${JSON.stringify(response.data, null, 2)}`);
    remoteComments = response.data.map(comment =>
      new RemoteComment(comment.id, comment.path, comment.original_line || comment.line, comment.body)
    );
    logVerbose(`Existed remote comments: ${JSON.stringify(remoteComments, null, 2)}`);
  } catch (error) {
    logError(`Failed to parse remote comments: ${error.message}`);
    return;
  }

  // Logic to determine which comments to create, update, or delete
  const commentsToAdd = inlineComments.filter(local =>
    !remoteComments.some(remote => remote.matchesLocalComment(local))
  );
  const commentsToDelete = remoteComments.filter(remote =>
    !inlineComments.some(local => remote.matchesLocalComment(local))
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

/// class

class DiffFile {
  constructor(fileName) {
    this.fileName = fileName;
    this.changes = [];
  }

  addChange(line) {
    this.changes.push(line);
  }

  hasChange(line) {
    return this.changes.includes(line);
  }
}

class Diff {
  constructor(data) {
    this.files = {};
    this.parse(data);
  }

  parse(data) {
    const diffLines = data.split('\n');
    let currentFile = '';
    let lineCounter = 0;

    for (const line of diffLines) {
      if (line.startsWith('+++ b/')) {
        currentFile = line.replace('+++ b/', '');
        lineCounter = 0;
      } else {
        const hunkHeaderMatch = line.match(/^@@ -\d+,?\d* \+(\d+),?\d* @@/);
        if (hunkHeaderMatch) {
          lineCounter = parseInt(hunkHeaderMatch[1], 10) - 1;
        } else if (line.startsWith('+')) {
          lineCounter++;
          this.addFileChange(currentFile, lineCounter, line);
        } else if (!line.startsWith('-')) {
          lineCounter++;
        }
      }
    }
  }

  addFileChange(fileName, line) {
    if (!this.files[fileName]) {
      this.files[fileName] = new DiffFile(fileName);
    }
    this.files[fileName].addChange(line);
  }

  fileHasChange(fileName, line) {
    return this.files[fileName] && this.files[fileName].hasChange(line);
  }
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

class Comment {
  constructor(issues) {
    const levelIcon = {
      'info': 'ℹ️',
      'warning': '⚠️',
      'error': '❌'
    };
    this.path = issues[0].file;
    this.line = issues[0].line;

    this.body = '<table><thead><tr><th>Level</th><th>Message</th></tr></thead><tbody>';
    this.body += issues.map(issue => {
      return `<tr><td>${levelIcon[issue.level]}</td><td>${issue.message}</td></tr>`;
    }).join('');
    this.body += '</tbody></table><!-- Flutter Analyze Commenter: issue -->';
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

/// function

function parseAnalyzerOutputs(analyzeLog, workingDir) {
  const regex = /\[(info|warning|error)\] (.+) \((.+):(\d+):(\d+)\)/g;
  const issues = [];
  let match;
  while ((match = regex.exec(analyzeLog))) {
    issues.push(new Issue(
      match[1],
      match[2],
      match[3].replace(workingDir, '').replace(/^(\\|\/)/, '').replace(/\\/, '/'),
      parseInt(match[4], 10),
      parseInt(match[5], 10)
    ));
  }
  return issues;
}

function filterIssuesByDiff(diff, issues) {
  const issuesInDiff = [];
  const issuesNotInDiff = [];

  for (const issue of issues) {
    if (diff.fileHasChange(issue.file, issue.line)) {
      issuesInDiff.push(issue);
    } else {
      issuesNotInDiff.push(issue);
    }
  }

  return { issuesInDiff, issuesNotInDiff };
}

function generateTableForIssuesNotInDiff(issuesNotInDiff) {
  const levelIcon = {
    'info': 'ℹ️',
    'warning': '⚠️',
    'error': '❌'
  };

  let tableRows = issuesNotInDiff.map(issue =>
    `<tr>` +
    `<td>${levelIcon[issue.level]}</td>` +
    `<td>${issue.file}</td>` +
    `<td>${issue.line}</td>` +
    `<td>${issue.message}</td>` +
    `</tr>`
  ).join('');

  return `<p>Flutter Analyze Commenter has detected the following issues, including those within your commits, and additional potential issues due to recent updates to the base branch:</p>` +
    `<table>` +
    `<thead><tr><th>Level</th><th>File</th><th>Line</th><th>Message</th></tr></thead>` +
    `<tbody>` +
    tableRows +
    `</tbody>` +
    `</table >` +
    `<!-- Flutter Analyze Commenter: outline issues -->`;
}

function groupIssuesByLine(issues) {
  const grouped = {};
  issues.forEach(issue => {
    const key = `${issue.file}:${issue.line}`;
    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key].push(issue);
  });
  return Object.values(grouped);
}

class CustomLintParser {
  constructor(jsonFile, workingDir) {
    this.jsonFile = jsonFile
    this.workingDir = workingDir
  }

  parse() {
    if (this.jsonFile === undefined || this.jsonFile === '') {
      return [];
    }

    const customLintLog = fs.readFileSync(this.jsonFile, 'utf-8');
    const jsonMatch = customLintLog.match(/{.*}/s);
    const jsonString = jsonMatch ? jsonMatch[0] : JSON.stringify(
      {
        "version": 1,
        "diagnostics": []
      }
    );
    const jsonData = JSON.parse(jsonString);
    return jsonData.diagnostics.map(diag => {
      return new Issue(
        diag.severity.toLowerCase(),
        diag.problemMessage,
        diag.location.file.replace(this.workingDir, '').replace(/^(\\|\/)/, '').replace(/\\/, '/'),
        diag.location.range.start.line,
        diag.location.range.start.column
      );
    });
  }
}
