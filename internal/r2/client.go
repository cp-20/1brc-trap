package r2

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type Config struct {
	Bucket    string
	Endpoint  string
	AccessKey string
	SecretKey string
}

func ResolveEndpoint(endpoint, accountID string) (string, error) {
	if endpoint != "" {
		return strings.TrimRight(endpoint, "/"), nil
	}
	if accountID == "" {
		return "", errors.New("R2 endpoint is required: set --endpoint/R2_ENDPOINT or --account-id/R2_ACCOUNT_ID")
	}
	return fmt.Sprintf("https://%s.r2.cloudflarestorage.com", accountID), nil
}

func (config Config) Validate() error {
	if config.Bucket == "" || config.AccessKey == "" || config.SecretKey == "" {
		return errors.New("bucket, access-key and secret-key are required")
	}
	return nil
}

func newClient(config Config) (*s3.Client, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	configuration, err := awsconfig.LoadDefaultConfig(
		context.Background(),
		awsconfig.WithRegion("auto"),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(config.AccessKey, config.SecretKey, "")),
	)
	if err != nil {
		return nil, err
	}
	return s3.NewFromConfig(configuration, func(options *s3.Options) {
		if config.Endpoint != "" {
			options.BaseEndpoint = aws.String(config.Endpoint)
			options.UsePathStyle = true
		}
	}), nil
}
