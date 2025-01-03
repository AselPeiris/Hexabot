/*
 * Copyright © 2025 Hexastack. All rights reserved.
 *
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3) with the following additional terms:
 * 1. The name "Hexabot" is a trademark of Hexastack. You may not use this name in derivative works without express written permission.
 * 2. All derivative works must include clear attribution to the original creator and software, Hexastack and Hexabot, in a prominent location (e.g., in the software's "About" section, documentation, and README file).
 */

import { existsSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectModel } from '@nestjs/mongoose';
import { kebabCase } from 'lodash';
import mongoose from 'mongoose';
import leanDefaults from 'mongoose-lean-defaults';
import leanGetters from 'mongoose-lean-getters';
import leanVirtuals from 'mongoose-lean-virtuals';

import { config } from '@/config';
import { LoggerService } from '@/logger/logger.service';
import { MetadataService } from '@/setting/services/metadata.service';
import idPlugin from '@/utils/schema-plugin/id.plugin';

import {
  Migration,
  MigrationDocument,
  MigrationModel,
} from './migration.schema';
import {
  MigrationAction,
  MigrationRunParams,
  MigrationSuccessCallback,
} from './types';

@Injectable()
export class MigrationService implements OnApplicationBootstrap {
  constructor(
    private moduleRef: ModuleRef,
    private readonly logger: LoggerService,
    private readonly metadataService: MetadataService,
    @InjectModel(Migration.name)
    private readonly migrationModel: MigrationModel,
  ) {
    this.validateMigrationPath();
  }

  async onApplicationBootstrap() {
    if (mongoose.connection.readyState !== 1) {
      await this.connect();
    }
    this.logger.log('Mongoose connection established');

    const isCLI = Boolean(process.env.HEXABOT_CLI);
    if (!isCLI && config.mongo.autoMigrate) {
      this.logger.log('Executing migrations ...');
      const { value: version = '2.1.9' } =
        await this.metadataService.getMetadata('db-version');
      await this.run({
        action: MigrationAction.UP,
        version,
        isAutoMigrate: true,
      });
    }
  }

  public exit() {
    process.exit(0);
  }

  // CREATE
  public get migrationFilePath() {
    return this.moduleRef.get('MONGO_MIGRATION_DIR');
  }

  public validateMigrationPath() {
    if (!existsSync(this.migrationFilePath)) {
      this.logger.error(
        `Migration directory "${this.migrationFilePath}" not exists.`,
      );
      this.exit();
    }
  }

  public async create(name: string) {
    const fileName: string = kebabCase(name) + '.migration.ts';

    // check if file already exists
    const files = await this.getDirFiles();
    const exist = files.some((file) => {
      const [, ...actualFileName] = file.split('-');
      const migrationName = actualFileName.join('-');
      return migrationName === fileName;
    });

    if (exist) {
      this.logger.error(`Migration file for "${name}" already exists`);
      this.exit();
    }

    const migrationFileName = `${Date.now()}-${fileName}`;
    const filePath = join(this.migrationFilePath, migrationFileName);
    const template = this.getMigrationTemplate();
    try {
      writeFileSync(filePath, template);
      this.logger.log(
        `Migration file for "${name}" created: ${migrationFileName}`,
      );
    } catch (e) {
      this.logger.error(e.stack);
    } finally {
      this.exit();
    }
  }

  private getMigrationTemplate() {
    return `import mongoose from 'mongoose';

module.exports = {
  async up() {
    // Migration logic
  },
  async down() {
    // Rollback logic
  },
};`;
  }

  private async connect() {
    try {
      const connection = await mongoose.connect(config.mongo.uri, {
        dbName: config.mongo.dbName,
      });

      connection.plugin(idPlugin);
      connection.plugin(leanVirtuals);
      connection.plugin(leanGetters);
      connection.plugin(leanDefaults);
    } catch (err) {
      this.logger.error('Failed to connect to MongoDB');
      throw err;
    }
  }

  public async run({
    action,
    name,
    version,
    isAutoMigrate,
  }: MigrationRunParams) {
    if (!name) {
      if (isAutoMigrate) {
        const newVersion = await this.runFromVersion(action, version);
        await this.metadataService.setMetadata('db-version', newVersion);
      } else {
        await this.runAll(action);
      }
    } else {
      await this.runOne({ action, name });
    }
    this.exit();
  }

  private async runOne({ name, action }: MigrationRunParams) {
    // verify DB status
    const { exist, migrationDocument } = await this.verifyStatus({
      name,
      action,
    });
    if (exist) {
      return true; // stop exec;
    }

    try {
      const migration = await this.loadMigrationFile(name);
      await migration[action]();
      await this.successCallback({
        name,
        action,
        migrationDocument,
      });
    } catch (e) {
      this.failureCallback({
        name,
        action,
      });
      this.logger.log(e.stack);
    }
  }

  isNewerVersion(version1: string, version2: string): boolean {
    const regex = /^v?(\d+)\.(\d+)\.(\d+)$/;
    if (!regex.test(version1) || !regex.test(version2)) {
      throw new TypeError('Invalid version number!');
    }

    // Split both versions into their numeric components
    const v1Parts = version1.replace('v', '').split('.').map(Number);
    const v2Parts = version2.replace('v', '').split('.').map(Number);

    // Compare each part of the version number
    for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
      const v1Part = v1Parts[i] || 0; // Default to 0 if undefined
      const v2Part = v2Parts[i] || 0; // Default to 0 if undefined

      if (v1Part > v2Part) {
        return true;
      } else if (v1Part < v2Part) {
        return false;
      }
    }

    // If all parts are equal, the versions are the same
    return false;
  }

  private async runFromVersion(action: MigrationAction, version: string) {
    const files = await this.getDirFiles();
    const migrationFiles = files
      .filter((fileName) => fileName.includes('migration'))
      .map((fileName) => {
        const [migrationFileName] = fileName.split('.');
        const [, , ...migrationVersion] = migrationFileName.split('-');
        return `v${migrationVersion.join('.')}`;
      })
      .filter((v) => this.isNewerVersion(v, version));

    let lastVersion = version;
    for (const name of migrationFiles) {
      await this.runOne({ name, action });
      lastVersion = name;
    }

    return lastVersion;
  }

  private async runAll(action: MigrationAction) {
    const files = await this.getDirFiles();
    const migrationFiles = files
      .filter((fileName) => fileName.includes('migration'))
      .map((fileName) => {
        const [migrationFileName] = fileName.split('.');
        const [, , ...migrationVersion] = migrationFileName.split('-');
        return `v${migrationVersion.join('.')}`;
      });

    for (const name of migrationFiles) {
      await this.runOne({ name, action });
    }
  }

  private async getDirFiles() {
    return readdirSync(this.migrationFilePath);
  }

  private async verifyStatus({ name, action }: MigrationRunParams): Promise<{
    exist: boolean;
    migrationDocument: MigrationDocument | null;
  }> {
    let exist = false;
    const migrationDocument = await this.migrationModel.findOne({ name });

    if (migrationDocument) {
      exist = Boolean(migrationDocument.status === action);
      if (exist) {
        this.logger.warn(
          `Cannot proceed migration "${name}" is already in "${action}" state`,
        );
      }
    }

    return { exist, migrationDocument };
  }

  private async getMigrationFiles() {
    const files = await this.getDirFiles();
    return files.filter((file) => /\.migration\.(js|ts)/.test(file));
  }

  private async findMigrationFileByName(name: string): Promise<string | null> {
    const files = await this.getMigrationFiles();
    return (
      files.find((file) => {
        const [, ...migrationNameParts] = file.split('-');
        const migrationName = migrationNameParts
          .join('-')
          .replace(/\.migration\.(js|ts)/, '');

        return migrationName === kebabCase(name);
      }) || null
    );
  }

  private async loadMigrationFile(name: string) {
    try {
      // Map the provided name to the actual file with timestamp
      const fileName = await this.findMigrationFileByName(name);
      if (!fileName) {
        this.logger.error(`Migration file for "${name}" not found.`);
        process.exit(1);
      }

      const filePath = join(this.migrationFilePath, fileName);
      const migration = await import(filePath);
      if (
        !migration ||
        typeof migration.up !== 'function' ||
        typeof migration.down !== 'function'
      ) {
        throw new Error(
          `Migration file "${name}" must export an object with "up" and "down" methods.`,
        );
      }
      return migration;
    } catch (e) {
      throw new Error(`Failed to load migration "${name}".\n${e.message}`);
    }
  }

  private async updateStatus({
    name,
    action,
    migrationDocument,
  }: Omit<MigrationSuccessCallback, 'terminal'>) {
    const document =
      migrationDocument ||
      new this.migrationModel({
        name,
      });
    document.status = action;
    await document.save();
  }

  private async successCallback({
    name,
    action,
    migrationDocument,
  }: MigrationSuccessCallback) {
    await this.updateStatus({ name, action, migrationDocument });
    const migrationDisplayName = `${name} [${action}]`;
    this.logger.log(`"${migrationDisplayName}" migration done`);
  }

  private failureCallback({ name, action }: MigrationRunParams) {
    const migrationDisplayName = `${name} [${action}]`;
    this.logger.error(`"${migrationDisplayName}" migration failed`);
  }
}
