// const action = require("./action");
// const prepare = require("./prepare");
const targets = require('./target');
const conditionalPrompt = require('./util/conditionalPrompt');
const validateNotOutsideWorkingDir = require('./util/validate/validateNotOutsideWorkingDir');
const Filenames = require('./data/Filenames');
const fs = require('fs-extra');
const inquirer = require('inquirer');
const path = require('path');
const chalk = require('chalk');

module.exports = async (options = {}, cli) => {
  const filepathRc = `./${Filenames.RC}`;
  const filepathGitIgnore = `./${Filenames.GITIGNORE}`;

  // checking for a .uploadrc
  let hasGitIgnore = await fs.pathExists(filepathGitIgnore);

  // checking if .gitignore is exists
  if (!hasGitIgnore) {
    const { shouldCreateGitIgnore } = await inquirer.prompt({
      type: 'confirm',
      name: 'shouldCreateGitIgnore',
      message: 'No .gitignore found should i create it?',
    });

    if (shouldCreateGitIgnore) {
      hasGitIgnore = true;
      await fs.outputFile(filepathGitIgnore, '');
    }
  }

  if (hasGitIgnore) {
    const gitIgnoreContent = await fs.readFile(filepathGitIgnore, 'utf8');

    const regEx = new RegExp(Filenames.RC, 'gm');

    if (!regEx.test(gitIgnoreContent)) {
      const { shouldAddIt } = await inquirer.prompt({
        type: 'confirm',
        name: 'shouldAddIt',
        message: `No ${Filenames.RC} was added to the ${Filenames.GITIGNORE}, should i add it?`,
      });

      if (shouldAddIt) {
        fs.outputFile(filepathGitIgnore, gitIgnoreContent.replace(/\n$/, '') + `\n${Filenames.RC}`);
      }
    }
  }

  if (await fs.pathExists(filepathRc)) {
    // uploadrc exists, reading data and validating
    let rc = {};

    try {
      rc = await fs.readJson(filepathRc);
    } catch (err) {
      throw new Error('cant read json from .uploadrc, please delete it and try again');
    }

    if (rc.hasOwnProperty('uploadConfigs')) {
      data = {
        ...rc,
      };
    } else {
      // uploadrc exists but not in correct new structure
      if (rc.hasOwnProperty('type')) {
        // looks like the object follows old structure
        data = {
          uploadConfigs: [rc],
        };
      } else {
        // no compatible structure found, creating new
        data = {
          uploadConfigs: [],
        };
      }
    }
  } else {
    console.log('uploadrc doesnt exist, creating creating new data obj');
    data = {
      uploadConfigs: [],
    };
  }

  const choices = [
    { name: 'Mediamonks Preview', value: 'mm-preview' },
    { name: 'Adform', value: 'adform' },
    // { name: 'Workspace', value: 'workspace' },
    { name: 'Flashtalking', value: 'flashtalking' },
    { name: 'Google DoubleClick Studio', value: 'doubleclick' },
    { name: 'SFTP (alpha)', value: 'sftp' },
    // { name: 'Amazon S3', value: 's3', disabled: true },
    // { name: 'FTP', value: 'ftp', disabled: true },
    // { name: 'Netflix Monet', value: 'monet', disabled: true },
  ];

  data.uploadConfigs.forEach((config) => {
    const configIndex = choices.findIndex((choice) => config.type === choice.value);
    if (configIndex !== -1) choices[configIndex].name += ' (Config Found)';
  });

  uploadTarget = await conditionalPrompt(options, {
    type: 'list',
    name: 'type',
    message: 'Where do you want to upload?',
    choices: choices,
  });

  const target = targets[uploadTarget.type];

  if (!target) {
    throw new Error(`unknown target ${uploadTarget.type}`);
  }

  let [targetData] = data.uploadConfigs.filter((config) => config.type === uploadTarget.type);
  if (!targetData) targetData = { type: uploadTarget.type };

  // quick hack to allow overwrite of inputDir and outputDir if using mm-preview
  targetData = {
    ...targetData,
    ...options, // options from commandline args could overwrite some of the keys in targetData like type, inputDir, outputDir
  };

  targetData = await conditionalPrompt(targetData, {
    type: 'input',
    name: 'inputDir',
    message: 'What directory you want to upload?',
    validate: validateNotOutsideWorkingDir,
  });

  // force relative directories.
  targetData.inputDir = path.relative('./', targetData.inputDir);

  // checking if inputDir exist
  targetData = await conditionalPrompt(targetData, target.questions);

  // find and overwrite the correct object in the array data.uploadConfigs
  const overwriteIndex = data.uploadConfigs.findIndex((config) => config.type === targetData.type);

  if (overwriteIndex === -1) {
    //console.log("adding new object to data")
    data.uploadConfigs.push(targetData); //this config was not in the uploadrc yet so adding a new object
  } else {
    data.uploadConfigs[overwriteIndex] = targetData; //found it, so overwriting the existing object
  }

  await fs.writeJSON(filepathRc, data, { spaces: 2 });

  // console.log(targetData)
  const start = Date.now();

  const result = await target.action(targetData);

  // Save the build information for future comparisons
  if (result) {
    if (result.previousOutputDir) targetData.previousOutputDir = result.previousOutputDir;

    // Save the updated configuration
    await fs.writeJSON(filepathRc, data, { spaces: 2 });
  }

  console.log(chalk.green(`Done in ${Date.now() - start}ms, Have a nice day!`));
};
