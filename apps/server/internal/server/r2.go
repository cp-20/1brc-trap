package server

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type r2Client struct {
	bucket   string
	public   *s3.PresignClient
	internal *s3.Client
}

func newR2Client(ctx context.Context, config Config) (*r2Client, error) {
	loaded, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion("auto"), awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(config.R2AccessKeyID, config.R2SecretAccessKey, "")))
	if err != nil {
		return nil, err
	}
	publicEndpoint := config.R2Endpoint
	if publicEndpoint == "" {
		publicEndpoint = fmt.Sprintf("https://%s.r2.cloudflarestorage.com", config.R2AccountID)
	}
	makeClient := func(endpoint string) *s3.Client {
		parsed, _ := url.Parse(endpoint)
		return s3.NewFromConfig(loaded, func(options *s3.Options) {
			options.BaseEndpoint = aws.String(strings.TrimRight(endpoint, "/"))
			options.UsePathStyle = parsed.Scheme != "https"
		})
	}
	public := makeClient(publicEndpoint)
	internal := public
	if config.R2InternalEndpoint != "" {
		internal = makeClient(config.R2InternalEndpoint)
	}
	return &r2Client{bucket: config.R2BucketName, public: s3.NewPresignClient(public), internal: internal}, nil
}
func (c *r2Client) verifyObject(ctx context.Context, key string) error {
	_, err := c.internal.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(c.bucket), Key: aws.String(key)})
	if err != nil {
		return newError(infrastructure, "r2_object_unavailable", fmt.Sprintf("R2上の公開データを確認できません: %s", key), err)
	}
	return nil
}
func (c *r2Client) signDownload(ctx context.Context, key, filename string) (string, error) {
	value := fmt.Sprintf("attachment; filename*=UTF-8''%s", encodeURIComponent(filename))
	result, err := c.public.PresignGetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(c.bucket), Key: aws.String(key), ResponseContentDisposition: aws.String(value)}, func(options *s3.PresignOptions) { options.Expires = 15 * time.Minute })
	if err != nil {
		return "", newError(infrastructure, "r2_signing_failed", "公開データのダウンロードURLを発行できません", err)
	}
	return result.URL, nil
}
