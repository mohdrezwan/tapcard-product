const appJson = require('./app.json');

module.exports = ({ config }) => ({
  ...appJson.expo,
  ...config,
  extra: {
    BASE_URL: process.env.BASE_URL || '',
  },
});
