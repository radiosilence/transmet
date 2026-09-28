/**
 * The version this chart deploys. The package and the image share one number,
 * so pinning `@radiosilence/transmet-pulumi@x` says exactly which build runs.
 * CI refuses a release where this and `package.json` disagree.
 */
export const APP_VERSION = "0.3.0";

export const IMAGE = `ghcr.io/radiosilence/transmet:${APP_VERSION}`;
