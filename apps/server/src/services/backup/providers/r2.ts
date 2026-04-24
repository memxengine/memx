/**
 * F153 — Cloudflare R2 backup provider.
 *
 * Thin S3-compatible adapter built on `@aws-sdk/client-s3` +
 * `@aws-sdk/lib-storage`'s multipart `Upload`. R2 needs:
 *   - `region: 'auto'`
 *   - `forcePathStyle: true` (same as every other S3-compatible host)
 *   - endpoint of the form `https://<account>.r2.cloudflarestorage.com`
 *
 * Pattern lifted from @webhouse/cms's S3BackupProvider. Dynamic imports
 * keep the AWS SDK off the hot boot path when backups are disabled.
 */

import type { Readable } from 'node:stream';
import type { BackupProvider, CloudBackupFile, R2ProviderConfig } from './types.js';

export class R2BackupProvider implements BackupProvider {
  readonly id = 'r2';
  readonly name: string;
  private readonly config: R2ProviderConfig;
  private readonly prefix: string;

  constructor(config: R2ProviderConfig) {
    this.config = config;
    const rawPrefix = config.prefix ?? 'trail-db/';
    this.prefix = rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`;
    this.name = `R2 (${config.bucket})`;
  }

  private async client() {
    const { S3Client } = await import('@aws-sdk/client-s3');
    return new S3Client({
      endpoint: this.config.endpoint,
      region: 'auto',
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
      forcePathStyle: true,
    });
  }

  async upload(
    filename: string,
    body: Readable,
    contentLength: number,
  ): Promise<{ key: string; size: number }> {
    const { Upload } = await import('@aws-sdk/lib-storage');
    const client = await this.client();
    const key = `${this.prefix}${filename}`;
    try {
      await new Upload({
        client,
        params: {
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
          ContentType: 'application/gzip',
        },
        queueSize: 4,
        // 8 MB parts — minimum is 5 MB for S3. Lower parts = more
        // requests; higher parts = more memory per in-flight part.
        partSize: 8 * 1024 * 1024,
      }).done();
    } finally {
      client.destroy();
    }
    return { key, size: contentLength };
  }

  async list(): Promise<CloudBackupFile[]> {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const client = await this.client();
    try {
      const out: CloudBackupFile[] = [];
      let continuationToken: string | undefined;
      do {
        const res = await client.send(
          new ListObjectsV2Command({
            Bucket: this.config.bucket,
            Prefix: this.prefix,
            ContinuationToken: continuationToken,
          }),
        );
        for (const obj of res.Contents ?? []) {
          if (!obj.Key || !obj.Key.endsWith('.db.gz')) continue;
          out.push({
            filename: obj.Key.replace(this.prefix, ''),
            size: obj.Size ?? 0,
            lastModified: obj.LastModified?.toISOString() ?? '',
          });
        }
        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (continuationToken);
      return out;
    } finally {
      client.destroy();
    }
  }

  async download(filename: string): Promise<Readable> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.client();
    const res = await client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: `${this.prefix}${filename}` }),
    );
    const body = res.Body;
    if (!body) throw new Error(`R2 returned empty body for ${filename}`);
    // The SDK's Body is a Node Readable in Node/Bun runtimes.
    return body as Readable;
  }

  async delete(filename: string): Promise<void> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.client();
    try {
      await client.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: `${this.prefix}${filename}`,
        }),
      );
    } finally {
      client.destroy();
    }
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const { HeadBucketCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const client = await this.client();
      try {
        await client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
        const list = await client.send(
          new ListObjectsV2Command({
            Bucket: this.config.bucket,
            Prefix: this.prefix,
            MaxKeys: 100,
          }),
        );
        const count = (list.Contents ?? []).filter((o) => o.Key?.endsWith('.db.gz')).length;
        return {
          ok: true,
          message: `Connected to ${this.config.bucket} — ${count} snapshot${count === 1 ? '' : 's'} stored under ${this.prefix}`,
        };
      } finally {
        client.destroy();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/403|Access Denied/i.test(msg)) {
        return { ok: false, message: 'Access denied — check API token permissions' };
      }
      if (/404|NoSuchBucket/i.test(msg)) {
        return { ok: false, message: `Bucket "${this.config.bucket}" not found` };
      }
      return { ok: false, message: msg };
    }
  }
}
