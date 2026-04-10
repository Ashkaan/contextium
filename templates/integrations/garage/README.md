# Garage

S3-compatible distributed object storage for backups and file hosting.

## Requirements

- Garage instance (self-hosted)
- Access key and secret key
- Endpoint URL

## Setup

1. Deploy Garage on your infrastructure
2. Create a bucket and access key via the admin API
3. Store access key, secret key, and endpoint URL in your vault
4. Configure your S3 client:

```bash
export AWS_ACCESS_KEY_ID="your-access-key"
export AWS_SECRET_ACCESS_KEY="your-secret-key"
export AWS_ENDPOINT_URL="https://your-garage-endpoint"
```

## Key Operations

```bash
aws s3 ls s3://bucket-name/                          # List objects
aws s3 cp file.txt s3://bucket-name/                  # Upload
aws s3 cp s3://bucket-name/file.txt ./                # Download
aws s3 sync ./local-dir s3://bucket-name/prefix/      # Sync directory
```

## Use Cases

- Storing backups of important data
- Hosting static assets
- Archiving processed files from automations
- Sharing files between services
