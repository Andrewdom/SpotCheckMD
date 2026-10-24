import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { assessImage, imageUploadLimitBytes } from "../lib/analysis";

test("inference copy preserves oriented pixels beyond 1600px and strips metadata", async () => {
  const original = await sharp({ create: { width: 2200, height: 1700, channels: 3, background: { r: 91, g: 123, b: 177 } } })
    .withMetadata({ orientation: 6 }).jpeg({ quality: 91 }).toBuffer();
  const assessed = await assessImage(original);

  assert.equal(assessed.mime, "image/png");
  assert.equal(assessed.width, 1700);
  assert.equal(assessed.height, 2200);
  const metadata = await sharp(assessed.normalized).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.orientation, undefined);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.width, 1700);
  assert.equal(metadata.height, 2200);

  const expected = await sharp(original).rotate().raw().toBuffer();
  const actual = await sharp(assessed.normalized).raw().toBuffer();
  assert.deepEqual(actual, expected);

  const preview = await sharp(assessed.preview).metadata();
  assert.equal(preview.format, "jpeg");
  assert.ok(Math.max(preview.width!, preview.height!) <= 1200);
});

test("image upload limit defaults to 50 MB and is configurable", () => {
  const previous = process.env.SPOTCHECK_IMAGE_UPLOAD_MAX_MB;
  try {
    delete process.env.SPOTCHECK_IMAGE_UPLOAD_MAX_MB;
    assert.equal(imageUploadLimitBytes(), 50 * 1024 * 1024);
    process.env.SPOTCHECK_IMAGE_UPLOAD_MAX_MB = "75";
    assert.equal(imageUploadLimitBytes(), 75 * 1024 * 1024);
    process.env.SPOTCHECK_IMAGE_UPLOAD_MAX_MB = "invalid";
    assert.throws(imageUploadLimitBytes, /must be an integer/);
  } finally {
    if (previous === undefined) delete process.env.SPOTCHECK_IMAGE_UPLOAD_MAX_MB;
    else process.env.SPOTCHECK_IMAGE_UPLOAD_MAX_MB = previous;
  }
});
