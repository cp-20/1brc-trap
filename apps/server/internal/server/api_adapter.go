package server

import (
	"github.com/cp-20/1blc-trap/apps/server/internal/api"
	"github.com/labstack/echo/v5"
)

type generatedServer struct{ server *Server }

var _ api.ServerInterface = generatedServer{}

func (a generatedServer) RevokeAccessKey(c *echo.Context) error {
	a.server.RevokeAccessKey(c.Response(), c.Request())
	return nil
}
func (a generatedServer) IssueAccessKey(c *echo.Context) error {
	a.server.IssueAccessKey(c.Response(), c.Request())
	return nil
}
func (a generatedServer) ImportDatasets(c *echo.Context) error {
	a.server.ImportDatasets(c.Response(), c.Request())
	return nil
}
func (a generatedServer) PublishPrivate(c *echo.Context) error {
	a.server.PublishPrivate(c.Response(), c.Request())
	return nil
}
func (a generatedServer) UnpublishPrivate(c *echo.Context) error {
	a.server.UnpublishPrivate(c.Response(), c.Request())
	return nil
}
func (a generatedServer) ListAdminSubmissions(c *echo.Context) error {
	a.server.ListAdminSubmissions(c.Response(), c.Request())
	return nil
}
func (a generatedServer) DisqualifySubmission(c *echo.Context, id api.Uuid) error {
	a.server.DisqualifySubmission(c.Response(), c.Request(), id)
	return nil
}
func (a generatedServer) RetrySubmission(c *echo.Context, id api.Uuid) error {
	a.server.RetrySubmission(c.Response(), c.Request(), id)
	return nil
}
func (a generatedServer) GetContest(c *echo.Context) error {
	a.server.GetContest(c.Response(), c.Request())
	return nil
}
func (a generatedServer) StreamContest(c *echo.Context, params api.StreamContestParams) error {
	a.server.StreamContest(c.Response(), c.Request(), params)
	return nil
}
func (a generatedServer) GetDatasets(c *echo.Context) error {
	a.server.GetDatasets(c.Response(), c.Request())
	return nil
}
func (a generatedServer) DownloadDataset(c *echo.Context, datasetID string, artifact api.DatasetKind) error {
	a.server.DownloadDataset(c.Response(), c.Request(), datasetID, artifact)
	return nil
}
func (a generatedServer) GetHealth(c *echo.Context) error {
	a.server.GetHealth(c.Response(), c.Request())
	return nil
}
func (a generatedServer) GetLeaderboard(c *echo.Context, params api.GetLeaderboardParams) error {
	a.server.GetLeaderboard(c.Response(), c.Request(), params)
	return nil
}
func (a generatedServer) GetLeaderboardReplay(c *echo.Context) error {
	a.server.GetLeaderboardReplay(c.Response(), c.Request())
	return nil
}
func (a generatedServer) GetMe(c *echo.Context) error {
	a.server.GetMe(c.Response(), c.Request())
	return nil
}
func (a generatedServer) GetReady(c *echo.Context) error {
	a.server.GetReady(c.Response(), c.Request())
	return nil
}
func (a generatedServer) ListSubmissions(c *echo.Context) error {
	a.server.ListSubmissions(c.Response(), c.Request())
	return nil
}
func (a generatedServer) CreateSubmission(c *echo.Context) error {
	a.server.CreateSubmission(c.Response(), c.Request())
	return nil
}
func (a generatedServer) StreamSubmissions(c *echo.Context) error {
	a.server.StreamSubmissions(c.Response(), c.Request())
	return nil
}
func (a generatedServer) GetSubmission(c *echo.Context, id api.Uuid) error {
	a.server.GetSubmission(c.Response(), c.Request(), id)
	return nil
}
func (a generatedServer) GetSubmissionSource(c *echo.Context, id api.Uuid) error {
	a.server.GetSubmissionSource(c.Response(), c.Request(), id)
	return nil
}
