const Command          = require('./-command');
const Hook             = require('../tasks/run-hook');
const logger           = require('../utils/logger');
const CordovaTarget    = require('../targets/cordova/target');
const CordovaRaw       = require('../targets/cordova/tasks/raw');
const editXml          = require('../targets/cordova/utils/edit-xml');
const getNetworkIp     = require('../utils/get-network-ip');
const requireFramework = require('../utils/require-framework');
const RSVP             = require('rsvp');
const Promise          = RSVP.Promise;

const listAndroidEms   = require('../targets/android/tasks/list-emulators');
const listAndroidDevices = require('../targets/android/tasks/list-devices');
const AndroidTarget    = require('../targets/android/target');
const listIOSEms       = require('../targets/ios/tasks/list-emulators');
const IOSTarget        = require('../targets/ios/target');

const CreateLiveReloadShell = require('../tasks/create-livereload-shell');

module.exports = Command.extend({
  name: 'start',
  aliases: [ 'start' ],
  description: 'Run app on device/emulator /w livereload',

  /* eslint-disable max-len */
  availableOptions: [
    { name: 'platform',   type: String },
    { name: 'emulator',   type: String,  default: '' },
    { name: 'emulatorid', type: String },
    { name: 'build',      type: Boolean },
    { name: 'reload-url', type: String,  aliases: ['r'] },
    { name: 'live-reload', type: Boolean, default: true,          aliases: ['lr'] },
    { name: 'port',       type: Number,  aliases: ['p'] },
    { name: 'force',                type: Boolean, default: false },
    { name: 'skip-framework-build', type: Boolean, default: false, aliases: ['sfb'] },
    { name: 'skip-cordova-build',   type: Boolean, default: false, aliases: ['scb'] }
  ],
  /* eslint-enable max-len */

  getReloadUrl(port, reloadUrl, framework) {
    if (reloadUrl) { return reloadUrl; }

    if (port === undefined) {
      port = framework.port;
    }

    let networkAddress = getNetworkIp();
    return 'http://' + networkAddress + ':' + port;
  },

  selectDevice(opts, installedPlatforms) {
    let foundDevices = [];
    if (opts.platform !== 'ios' && installedPlatforms.includes('android')) {
      foundDevices.push(listAndroidEms());
      foundDevices.push(listAndroidDevices());
    }

    if (opts.platform !== 'android' && installedPlatforms.includes('ios')) {
      foundDevices.push(listIOSEms());
    }

    return RSVP.allSettled(foundDevices).then((results) => {
      let devices = results.reduce((arr, result) => {
        if (result.state === 'fulfilled') {
          return arr.concat(result.value);
        }
        return arr;
      }, []);

      if (devices.length === 0) {
        let error = `
          No emulators or devices found. You must connect a device or install
          an iOS or Android emulator before running "corber start".`;

        if (opts.platform !== 'android' && installedPlatforms.includes('ios')) {
          error += `

          To run on an iOS emulator, you may first need to run:

          sudo xcode-select -s /Applications/Xcode.app/Contents/Developer

          more: http://corber.io/pages/ios-setup`
        }

        throw error;
      }

      if (opts.emulator === '') {
        let promptOpts = {
          type: 'list',
          name: 'device',
          message: 'Select a device/emulator',
          pageSize: 30,
          choices: []
        };

        devices.forEach((em, i) => {
          promptOpts.choices.push({
            key: i,
            name: em.label(),
            value: em
          });
        });

        return this.ui.prompt(promptOpts).then((selected) => {
          return selected.device;
        });
      } else {
        //Preference --emulator vs emulatorID if passed
        let device;
        if (opts.emulator) {
          device = devices.find(function(d) {
            if (d.name === opts.emulator) { return d; }
          });
        }

        return Promise.resolve(device);
      }
    });
  },

  validatePlatform(installedPlatforms, targetPlatform) {
    // only perform check when `targetPlatform` is specified
    if (targetPlatform && !installedPlatforms.includes(targetPlatform)) {
      throw `
        You are passing platform=${targetPlatform} which is not installed.
        Try running corber platform add ${targetPlatform}`;
    }
  },

  run(opts) {
    this._super.apply(this, arguments);
    logger.info('Corber Starting');

    let cdvTarget = new CordovaTarget({
      project: this.project
    });

    return new Promise((resolve, reject) => {
      return cdvTarget.getInstalledPlatforms().then((platforms) => {
        if (platforms.length === 0) {
          throw `
            No platforms installed. Install a platform using

              corber platform add <ios|android>

            before running "corber start".`;
        }

        this.validatePlatform(platforms, opts.platform);
        return this.selectDevice(opts, platforms);
      }).then((device) => {
        //supports webpack addon
        this.project.CORBER_PLATFORM = device.platform;

        // allows platform-specific tuning in framework build pipeline
        process.env.CORBER_PLATFORM = device.platform;
        process.env.CORBER_LIVERELOAD = true;

        cdvTarget.platform = device.platform;

        let platformTarget;
        if (device.platform === 'ios') {
          platformTarget = new IOSTarget({
            device: device,
            project: this.project
          });
        } else if (device.platform === 'android') {
          platformTarget = new AndroidTarget({
            device: device,
            project: this.project
          });
        }

        let framework = requireFramework(this.project);
        let reloadUrl = this.getReloadUrl(opts.port, opts.reloadUrl, framework);

        let createLivereloadShell = new CreateLiveReloadShell({
          project: this.project
        });

        let prepare = new CordovaRaw({
          project: this.project,
          api: 'prepare'
        });

        let hook = new Hook({
          project: this.project
        });

        return hook.run('beforeBuild')
          .then(() => editXml.addNavigation(this.project, reloadUrl))
          .then(() => cdvTarget.validateServe())
          .then(() => framework.validateServe(opts))
          .then(() => createLivereloadShell.run(reloadUrl))
          .then(() => prepare.run({ platforms: [device.platform] }))
          .then(function() {
            if (opts.skipCordovaBuild !== true) {
              return platformTarget.build();
            }
          })
          .then(() => hook.run('afterBuild'))
          .then(() => platformTarget.run())
          .then(() => {
            if (opts.skipFrameworkBuild !== true) {
              return framework.serve(opts);
            }
          })
          .then(resolve).catch(reject)
      }).catch(function(e) {
        logger.error(e);
      })
    });
  }
});
