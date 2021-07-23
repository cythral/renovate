import { join } from 'path';
import { getAdminConfig } from '../../config/admin';
import { TEMPORARY_ERROR } from '../../constants/error-messages';
import { id, parseRegistryUrl } from '../../datasource/nuget';
import { logger } from '../../logger';
import { ExecOptions, exec } from '../../util/exec';
import {
  ensureCacheDir,
  getSiblingFileName,
  outputFile,
  readLocalDirectory,
  readLocalDirectoryRecursive,
  readLocalFile,
  remove,
  writeLocalFile,
} from '../../util/fs';
import { File } from '../../util/git';
import * as hostRules from '../../util/host-rules';
import type {
  UpdateArtifact,
  UpdateArtifactsConfig,
  UpdateArtifactsResult,
} from '../types';
import {
  getConfiguredRegistries,
  getDefaultRegistries,
  getRandomString,
} from './util';

async function addSourceCmds(
  packageFileName: string,
  config: UpdateArtifactsConfig,
  nugetConfigFile: string
): Promise<string[]> {
  const { localDir } = getAdminConfig();
  const registries =
    (await getConfiguredRegistries(packageFileName, localDir)) ||
    getDefaultRegistries();
  const result = [];
  for (const registry of registries) {
    const { username, password } = hostRules.find({
      hostType: id,
      url: registry.url,
    });
    const registryInfo = parseRegistryUrl(registry.url);
    let addSourceCmd = `dotnet nuget add source ${registryInfo.feedUrl} --configfile ${nugetConfigFile}`;
    if (registry.name) {
      // Add name for registry, if known.
      addSourceCmd += ` --name ${registry.name}`;
    }
    if (username && password) {
      // Add registry credentials from host rules, if configured.
      addSourceCmd += ` --username ${username} --password ${password} --store-password-in-clear-text`;
    }
    result.push(addSourceCmd);
  }
  return result;
}

function getDotnetConstraint(
  globalJsonContent: string,
  config: UpdateArtifactsConfig
): string | null {
  const { constraints = {} } = config;
  const { dotnet } = constraints;

  if (dotnet) {
    logger.debug('Using dotnet constraint from config');
    return dotnet;
  }
  try {
    const globalJson = JSON.parse(globalJsonContent);
    if (globalJson.sdk.version) {
      return globalJson.sdk.version;
    }
  } catch (err) {
    // Do nothing
  }
  return '';
}

async function getSolutionFile(): Promise<string | undefined> {
  const filesInLocalDirectory = await readLocalDirectory('/');
  for (const file of filesInLocalDirectory) {
    if (file.endsWith('.sln')) {
      return file;
    }
  }

  return undefined;
}

async function getLockFiles(): Promise<File[]> {
  const promises = (await readLocalDirectoryRecursive('/'))
    .filter((fileName) => fileName.endsWith('/packages.lock.json'))
    .map(async (fileName) => ({
      name: fileName,
      contents: await readLocalFile(fileName),
    }));

  const result = await Promise.all(promises);
  return result;
}

async function getChangedLockFiles(existingLockFiles: File[]): Promise<File[]> {
  const result = [];
  for (const lockFile of existingLockFiles) {
    const newContents = await readLocalFile(lockFile.name);
    if (lockFile.contents !== newContents) {
      lockFile.contents = newContents;
      result.push(lockFile);
    }
  }
  return result;
}

async function runDotnetRestore(
  packageFileName: string,
  config: UpdateArtifactsConfig
): Promise<void> {
  const globalJsonContent = await readLocalFile('global.json', 'utf8');
  const tagConstraint = getDotnetConstraint(globalJsonContent, config);
  const execOptions: ExecOptions = {
    docker: {
      image: 'dotnet',
      tagConstraint,
    },
  };

  const nugetConfigDir = await ensureCacheDir(
    `./others/nuget/${getRandomString()}`
  );
  const nugetConfigFile = join(nugetConfigDir, 'nuget.config');
  await outputFile(
    nugetConfigFile,
    `<?xml version="1.0" encoding="utf-8"?>\n<configuration>\n</configuration>\n`
  );
  const solutionFile = await getSolutionFile();
  const cmds = [
    ...(await addSourceCmds(packageFileName, config, nugetConfigFile)),
    `dotnet restore ${
      solutionFile ?? packageFileName
    } --force-evaluate --configfile ${nugetConfigFile}`,
  ];
  logger.debug({ cmd: cmds }, 'dotnet command');
  await exec(cmds, execOptions);
  await remove(nugetConfigDir);
}

export async function updateArtifacts({
  packageFileName,
  newPackageFileContent,
  config,
  updatedDeps,
}: UpdateArtifact): Promise<UpdateArtifactsResult[] | null> {
  logger.debug(`nuget.updateArtifacts(${packageFileName})`);

  if (!/(?:cs|vb|fs)proj$/i.test(packageFileName)) {
    // This could be implemented in the future if necessary.
    // It's not that easy though because the questions which
    // project file to restore how to determine which lock files
    // have been changed in such cases.
    logger.debug(
      { packageFileName },
      'Not updating lock file for non project files'
    );
    return null;
  }

  const lockFileName = getSiblingFileName(
    packageFileName,
    'packages.lock.json'
  );
  const existingLockFileContent = await readLocalFile(lockFileName, 'utf8');
  if (!existingLockFileContent) {
    logger.debug(
      { packageFileName },
      'No lock file found beneath package file.'
    );
    return null;
  }

  const existingLockFiles = await getLockFiles();

  try {
    if (updatedDeps.length === 0 && config.isLockFileMaintenance !== true) {
      logger.debug(
        `Not updating lock file because no deps changed and no lock file maintenance.`
      );
      return null;
    }

    await writeLocalFile(packageFileName, newPackageFileContent);

    await runDotnetRestore(packageFileName, config);

    const changedLockFiles = await getChangedLockFiles(existingLockFiles);
    if (changedLockFiles.length === 0) {
      logger.debug(`Lock file is unchanged`);
      return null;
    }
    logger.debug('Returning updated lock file');
    return changedLockFiles.map((file) => ({ file }));
  } catch (err) {
    // istanbul ignore if
    if (err.message === TEMPORARY_ERROR) {
      throw err;
    }
    logger.debug({ err }, 'Failed to generate lock file');
    return [
      {
        artifactError: {
          lockFile: lockFileName,
          stderr: err.message,
        },
      },
    ];
  }
}
