const validateActionInput = require('../util/validateActionInput');
const validateNotOutsideWorkingDir = require('../util/validate/validateNotOutsideWorkingDir');
const validateNotEmpty = require('../util/validate/validateNotEmpty');
const { v4: uuidv4 } = require('uuid');
const open = require('open');
const fs = require('fs-extra');
const path = require('path');
// const fs = require('fs');
const globPromise = require('glob-promise');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@aws-sdk/node-http-handler');
const cliProgress = require('cli-progress');

const mime = require('mime-types');

const preview = {
  questions: [
    {
      type: 'input',
      name: 'bucket',
      message: 'Please fill in the name for the S3 Bucket:',
      default: process.env.preview_s3bucket,
      errorMessage: 'Missing bucket',
      validate: validateNotEmpty,
      required: true,
    },
    {
      type: 'input',
      name: 'accessKeyId',
      message: 'Please fill in the accessKeyId for the S3 Bucket:',
      default: process.env.preview_accessKeyId,
      errorMessage: 'Missing accessKeyId',
      validate: validateNotEmpty,
      required: true,
    },
    {
      type: 'input',
      name: 'secretAccessKey',
      message: 'Please fill in the secretAccessKey for the S3 Bucket:',
      default: process.env.preview_accessKeySecret,
      validate: validateNotEmpty,
      errorMessage: 'Missing secretAccessKey',
      required: true,
    },

    {
      type: 'input',
      name: 'outputDir',
      description: 'Please fill in the target directory:',
      default: () => `${uuidv4()}/`,
      validate: validateNotEmpty,
      errorMessage: 'Missing target ',
      required: true,
    },
  ],
  async action(data) {
    if (!data.outputDir) {
      data.outputDir = `${uuid()}/`;
    }

    validateActionInput(data, this.questions);

    // folder name with newly builded banners
    const currentBuildDir = data.inputDir; // build folder

    // folder with previously builded banners
    const prevBuildStorageDir = path.join(process.cwd(), '.prev-build-snapshot');

    // checking if previous version exists
    const hasPrevBuild = await fs.pathExists(prevBuildStorageDir);

    const client = new S3Client({
      region: 'us-east-1',
      credentials: {
        accessKeyId: data.accessKeyId,
        secretAccessKey: data.secretAccessKey,
      },
      requestHandler: new NodeHttpHandler({
        socketTimeout: 3000,
        timeoutByRequestType: {
          default: 3000,
        },
        maxSockets: 200, // Increase from default 50
      }),
    });

    // Get a list of all files in the current build
    const allFiles = await globPromise(`${currentBuildDir.replace(/\\/g, '/')}/**/*`);
    const fileList = (
      await Promise.all(
        allFiles.map(async (file) => {
          if ((await fs.lstat(file)).isFile()) {
            return path.relative(currentBuildDir, file).replace(/\\/g, '/');
          }
          return null;
        }),
      )
    ).filter(Boolean);

    // Identify the modified files by comparing with the previous build
    let changedFiles = [];

    if (hasPrevBuild) {
      console.log('Previous build found. Define modified files...');

      changedFiles = await Promise.all(
        fileList.map(async (relativePath) => {
          //ignoring zip files
          if (relativePath.endsWith('.zip')) {
            return null;
          }

          const currentFile = path.join(currentBuildDir, relativePath);
          const prevFile = path.join(prevBuildStorageDir, relativePath);

          // Check if the file exists in the previous build
          if (!(await fs.pathExists(prevFile))) {
            return relativePath; // new file
          }

          // Comparing file contents
          const currentContent = await fs.readFile(currentFile);
          const prevContent = await fs.readFile(prevFile);

          if (!currentContent.equals(prevContent)) {
            return relativePath; // Modified file
          }

          return null; // Unmodified file
        }),
      );

      changedFiles = changedFiles.filter(Boolean);
      console.log(`Found ${changedFiles.length} of changed files from ${fileList.length}`);
    } else {
      console.log('Previous build not found. Download all files...');
      changedFiles = fileList; // All files are considered modified
    }

    // If there are no changes, open an existing preview
    if (changedFiles.length === 0 && data.previousOutputDir) {
      console.log('No changes detected. Open an existing preview.');
      open(`http://${data.bucket}.s3.amazonaws.com/${data.previousOutputDir}index.html`);
      return {
        previousOutputDir: data.previousOutputDir,
      };
    }

    console.log('edited files: ', changedFiles);

    // Uploading files to the S3
    const filesToUpload = changedFiles.length > 0 ? changedFiles : fileList;
    const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    progressBar.start(filesToUpload.length, 0);

    // Use batch loading to improve performance
    const BATCH_SIZE = 50;
    for (let i = 0; i < filesToUpload.length; i += BATCH_SIZE) {
      const batch = filesToUpload.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (relativePath) => {
          const fullPath = path.join(data.inputDir, relativePath);
          try {
            await client.send(
              new PutObjectCommand({
                Bucket: data.bucket,
                Key: data.outputDir + relativePath,
                ContentType: mime.lookup(fullPath),
                Body: await fs.readFile(fullPath),
              }),
            );
          } catch (e) {
            console.log(`Error during download ${relativePath}:`, e);
          }
          progressBar.increment();
        }),
      );
    }

    progressBar.stop();

    // After successful download, save the current build (without zip files) as the previous one
    console.log('Saving the current build for future comparisons...');
    await fs.emptyDir(prevBuildStorageDir);
    // await fs.copy(currentBuildDir, prevBuildStorageDir);

    await fs.copy(currentBuildDir, prevBuildStorageDir, {
      filter: (src, dest) => {
        // ignoring ZIP-files
        if (src.toLowerCase().endsWith('.zip')) {
          return false;
        }

        // copy all other files
        return true;
      },
    });

    console.log(`go to http://${data.bucket}.s3.amazonaws.com/${data.outputDir}index.html`);
    open(`http://${data.bucket}.s3.amazonaws.com/${data.outputDir}index.html`);

    // Return the information to be saved in .uploadrc
    return {
      previousOutputDir: data.outputDir,
    };
  },
};

module.exports = preview;
