const chunk = require("lodash.chunk");
const { Dropbox } = require("dropbox");
const fetch = require("isomorphic-fetch");
const fs = require("fs");
const fsExtra = require("fs-extra");
const open = require("open");
const inquirer = require("inquirer");

const FILE_FETCH_LIMIT = 50;
const BATCH_SIZE = 25;
const files = [];

let folderFetchesInProgress = 0;
let dropboxClient;
let fileRegex;

function start() {
  inquirer
    .prompt([
      {
        type: "password",
        name: "accessToken",
        message: "Dropbox API access token: ",
      },
      {
        type: "input",
        name: "folderPath",
        message: "Dropbox folder path: ",
      },
      {
        type: "input",
        name: "fileRegex",
        message: "Regex for files to delete: ",
      },
    ])
    .then(handleUserInput);
}

function handleUserInput(answers) {
  dropboxClient = new Dropbox({ fetch, accessToken: answers.accessToken });
  fetchFiles({ folderPath: answers.folderPath });

  try {
    fileRegex = new RegExp(answers.fileRegex);
  } catch {
    console.error("Invalid regex provided: ", answers.fileRegex);
    process.exit();
  }
}

function handleFileResponse(resp) {
  resp.entries.forEach((entry) => {
    if (entry[".tag"] === "folder") {
      fetchFiles({ folderPath: entry.path_lower });
    } else {
      console.log(`-- ${entry.name}`);
      files.push({
        id: entry.id,
        name: entry.name,
        path_lower: entry.path_lower,
        path_display: entry.path_display,
      });
    }
  });

  if (resp.has_more) {
    fetchFiles({ cursor: resp.cursor });
  } else {
    folderFetchesInProgress -= 1;
    if (folderFetchesInProgress === 0) {
      collectFilesForDeletion(fileRegex);
    }
  }
}

function fetchFiles({ folderPath, cursor }) {
  if (cursor) {
    dropboxClient
      .filesListFolderContinue({ cursor })
      .then(handleFileResponse, console.error);
  } else {
    folderFetchesInProgress += 1;
    dropboxClient
      .filesListFolder({
        limit: FILE_FETCH_LIMIT,
        path: folderPath,
        include_deleted: false,
      })
      .then(handleFileResponse, console.error);
  }
}

function collectFilesForDeletion(fileRegex) {
  const filesToDelete = files.filter((file) => file.name.match(fileRegex));

  console.log(`\n==============================\n`);
  if (filesToDelete.length) {
    console.log(
      `Found ${filesToDelete.length} matching files out of ${files.length} total files\n`
    );
  } else {
    console.log("No matching files found");
    process.exit();
  }

  inquirer
    .prompt([
      {
        type: "input",
        name: "preview",
        message: "Preview files before continuing? y/n",
      },
    ])
    .then((answers) => {
      if (answers.preview === "y") {
        console.log("\nGenerating preview. Please be patient...");
        generateHTMLPreview(filesToDelete).then(() =>
          confirmAndExecuteDeletion(filesToDelete)
        );
      } else {
        confirmAndExecuteDeletion(filesToDelete);
      }
    });
}

async function generateHTMLPreview(files) {
  let html = `<html><body><div><h1>${files.length} files will be deleted</h1>`;

  const thumbnailBatchRequests = chunk(files, BATCH_SIZE).map((fileChunk) => {
    const entries = fileChunk.map((f) => ({
      path: f.path_lower,
      size: { ".tag": "w128h128" },
    }));
    return dropboxClient.filesGetThumbnailBatch({ entries });
  });

  const thumbnailBatchResults = await Promise.allSettled(
    thumbnailBatchRequests
  );

  if (!fs.existsSync("./thumbnails/")) {
    fs.mkdirSync("./thumbnails/");
  } else {
    fsExtra.emptyDirSync("./thumbnails/");
  }

  thumbnailBatchResults.forEach((batchResult) => {
    batchResult.value.entries.forEach((thumbnailResult) => {
      const thumbnailFilePath = `./thumbnails/${thumbnailResult.metadata.name}.jpg`;
      fs.writeFileSync(thumbnailFilePath, thumbnailResult.thumbnail, {
        encoding: "base64",
      });
      html += `<div><img src="${thumbnailFilePath}"/><p>${thumbnailResult.metadata.name}</p></div>`;
    });
  });

  html += "</div></body></html>";

  const previewFileName = "./preview.html";
  fs.writeFileSync(previewFileName, html);
  open(previewFileName);
}

function confirmAndExecuteDeletion(files) {
  inquirer
    .prompt([
      {
        type: "input",
        name: "confirmation",
        message: "Are you ready to commence deletion? y/n",
      },
    ])
    .then((answers) => {
      if (answers.confirmation === "y") {
        console.log("Ok, lets do this thang!");
        deleteFiles(files);
      } else {
        console.log("Ok, then... goodbye!");
        process.exit();
      }
    });
}

async function deleteFiles(filesToDelete) {
  console.log("Deleting files");

  const entries = filesToDelete.map((f) => ({ path: f.path_lower }));

  const result = await dropboxClient.filesDeleteBatch({ entries });
  const jobId = result.async_job_id;
  let completed = result.complete;

  while (!completed) {
    process.stdout.write("...");

    try {
      const jobStatus = await dropboxClient.filesDeleteBatchCheck({
        async_job_id: jobId,
      });
    } catch (err) {
      console.error("Batch check request failed: ", err);
      continue;
    }

    if (jobStatus[".tag"] === "in_progress") continue;
    completed = true;

    if (jobStatus[".tag"] === "complete") {
      console.log("\nSuccess!");
    } else if (jobStatus[".tag"] === "failed") {
      console.error("Batch deletion failed: ", jobStatus[".tag"]);
    }
  }
}

start();
