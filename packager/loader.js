// MIT Licensed.
// https://github.com/forkphorus/sb-downloader

// Note: The API of SBDL is not very easy to integrate. Please consider another API first.
// The API is only designed for web environments, and the progress monitoring API is very strange and doesn't support concurrent downloads properly.
// Also the API can return two types of results (zip or buffer) and you have to handle both of them in different ways.

// If you want to use this library still, see index.html for a pretty complete usage example (notably downloadProject())
// Converting projects to archives may require JSZip: https://stuk.github.io/jszip/ (tested on 3.1.5)

window.SBDL = (function() {
  'use strict';

  /**
   * An error where the project cannot be loaded as the desired type, but it is likely that this project is of another format.
   */
  class ProjectFormatError extends Error {
    constructor(message, probableType) {
      super(message + ' (probably a .' + probableType + ')');
      this.probableType = probableType;
    }
  }

  class CannotAccessProjectError extends Error {
    constructor(message) {
      super(message);
      this.name = 'CannotAccessProjectError';
    }
  }

  const SB_MAGIC = 'ScratchV0';
  const ZIP_MAGIC = 'PK';

  const fetchQueue = {
    concurrentRequests: 0,
    maxConcurrentRequests: 30,
    queue: [],
    add(url) {
      return new Promise((resolve, reject) => {
        this.queue.push({ url: url, resolve: resolve, reject: reject });
        if (this.concurrentRequests < this.maxConcurrentRequests) {
          this.processNext();
        }
      });
    },
    processNext() {
      if (this.queue.length === 0) {
        return;
      }
      const request = this.queue.shift();
      this.concurrentRequests++;
      window.fetch(request.url)
        .then((r) => {
          this.concurrentRequests--;
          this.processNext();
          request.resolve(r);
        })
        .catch((err) => {
          this.concurrentRequests--;
          this.processNext();
          request.reject(err);
        });
    },
  };

  function fetch(url) {
    return fetchQueue.add(url);
  }

  // Customizable hooks that can be overridden by other scripts to measure progress.
  const progressHooks = {
    // Indicates a loader has just started
    start() {},
    // Indicates a new task has started.
    newTask() {},
    // Indicates a task has finished
    finishTask() {},
  };

  function checkMagic(buffer, magic) {
    const header = new Uint8Array(buffer.slice(0, magic.length));
    for (let i = 0; i < magic.length; i++) {
      if (header[i] !== magic.charCodeAt(i)) {
        return false;
      }
    }
    return true;
  }

  // Sorts a list of files in-place.
  function sortFiles(files) {
    files.sort((a, b) => {
      const nameA = a.path;
      const nameB = b.path;

      // project.json always the top
      if (nameA === "project.json") {
        return -1;
      } else if (nameB === "project.json") {
        return 1;
      }

      const valueA = +nameA.split('.').shift() || 0;
      const valueB = +nameB.split('.').shift() || 0;

      if (valueA < valueB) {
        return -1;
      } else if (valueA > valueB) {
        return 1;
      }

      // Fallback to just a string compare
      return nameA.localeCompare(nameB);
    });
  }
  
  // Loads a Scratch 1 project
  function loadScratch1Project(id) {
    const PROJECTS_API = 'https://projects.scratch.mit.edu/internalapi/project/$id/get/';

    const result = {
      title: id.toString(),
      extension: 'sb',
      // Scratch 1 projects load as buffers because they use a custom format that I don't want to implement.
      // The API only responds with the full file.
      type: 'buffer',
      buffer: null,
    };

    return fetch(PROJECTS_API.replace('$id', id))
      .then((data) => data.arrayBuffer())
      .then((buffer) => {
        if (!checkMagic(buffer, SB_MAGIC)) {
          throw new Error('Project is not a valid .sb file (failed magic check)');
        }
        result.buffer = buffer;
        return result;
      });
  }

  // Loads a Scratch 2 project
  function loadScratch2Project(id) {
    const PROJECTS_API = 'https://projects.scratch.mit.edu/internalapi/project/$id/get/';

    // Scratch 2 projects can either by stored as JSON (project.json) or binary (sb2 file)
    // JSON example: https://scratch.mit.edu/projects/15832807 (most Scratch 2 projects are like this)
    // Binary example: https://scratch.mit.edu/projects/250740608

    progressHooks.start();
    progressHooks.newTask();

    let blob;

    // The fetch routine is rather complicated because we have to determine which type of project we are looking at.
    return fetch(PROJECTS_API.replace('$id', id))
      .then((request) => {
        if (request.status !== 200) {
          throw new Error('Returned status code: ' + request.status);
        }
        return request.blob();
      })
      .then((b) => {
        blob = b;
        return new Promise((resolve, reject) => {
          const fileReader = new FileReader();
          fileReader.onload = () => resolve(fileReader.result);
          fileReader.onerror = () => reject(new Error('Cannot read blob as text'));
          fileReader.readAsText(blob);
        });
      })
      .then((text) => {
        let projectData;
        try {
          projectData = JSON.parse(text);
        } catch (e) {
          return loadScratch2BinaryProject(id, blob);
        }
        return loadScratch2JSONProject(id, projectData);
      })
      .then((result) => {
        progressHooks.finishTask();
        return result;
      });
  }

  // Loads a Scratch 2 binary-type project
  function loadScratch2BinaryProject(id, blob) {
    return new Promise((resolve, reject) => {
      const fileReader = new FileReader();
      fileReader.onload = () => {
        if (!checkMagic(fileReader.result, ZIP_MAGIC)) {
          if (checkMagic(fileReader.result, SB_MAGIC)) {
            reject(new ProjectFormatError('File is not a valid .sb2 (failed magic check)', 'sb'))
          }
          reject(new Error('File is not a valid .sb2 (failed magic check)'));
          return;
        }
        
        resolve({
          title: id.toString(),
          extension: 'sb2',
          type: 'buffer',
          buffer: fileReader.result,
        });
      };
      fileReader.onerror = () => reject(new Error('Cannot read blob as array buffer'));
      fileReader.readAsArrayBuffer(blob);
    });
  }

  // Loads a Scratch 2 JSON-type project
  function loadScratch2JSONProject(id, projectData) {
    const ASSETS_API = 'https://cdn.assets.scratch.mit.edu/internalapi/asset/$path/get/';

    const IMAGE_EXTENSIONS = [
      'svg',
      'png',
      'jpg',
      'jpeg',
      'bmp',
      'gif'
    ];
    const SOUND_EXTENSIONS = [
      'wav',
      'mp3',
    ];

    const result = {
      title: id.toString(),
      extension: 'sb2',
      files: [],
      type: 'zip',
    };

    // sb2 files have two ways of storing references to files.
    // In the online editor they use md5 hashes which point to an API destination.
    // In the offline editor they use separate accumulative file IDs for images and sounds.
    // The files served from the Scratch API don't contain the file IDs we need to export a valid .sb2, so we must create those ourselves.

    let soundAccumulator = 0;
    let imageAccumulator = 0;

    // Gets the md5 and extension of an object.
    function md5Of(thing) {
      // Search for any of the possible md5 attributes, falling back to just stringifying the input.
      return thing.md5 || thing.baseLayerMD5 || thing.penLayerMD5 || thing.toString();
    }

    function claimAccumulatedID(extension) {
      if (IMAGE_EXTENSIONS.includes(extension)) {
        return imageAccumulator++;
      } else if (SOUND_EXTENSIONS.includes(extension)) {
        return soundAccumulator++;
      } else {
        throw new Error('unknown extension: ' + extension);
      }
    }

    function addAsset(asset) {
      progressHooks.newTask();

      const md5 = asset.md5;
      const extension = asset.extension;
      const accumulator = claimAccumulatedID(extension);
      const path = accumulator + '.' + extension;

      // Update IDs in all references to match the accumulator
      // Downloaded projects usually use -1 for all of these, but sometimes they exist and are just wrong since we're redoing them all.
      for (const reference of asset.references) {
        if ('baseLayerID' in reference) {
          reference.baseLayerID = accumulator;
        }
        if ('soundID' in reference) {
          reference.soundID = accumulator;
        }
        if ('penLayerID' in reference) {
          reference.penLayerID = accumulator;
        }
      }

      return fetch(ASSETS_API.replace('$path', md5))
        .then((request) => request.arrayBuffer())
        .then((buffer) => {
          result.files.push({
            path: path,
            data: buffer,
          });
          progressHooks.finishTask();
        });
    }

    // Processes a list of assets
    // Finds and groups duplicate assets.
    function processAssets(assets) {
      // Records a list of all unique asset md5s and stores all references to an asset.
      const hashToAssetMap = Object.create(null);
      const allAssets = [];

      for (const data of assets) {
        const md5ext = md5Of(data);
        if (!(md5ext in hashToAssetMap)) {
          const asset = {
            md5: md5ext,
            extension: md5ext.split('.').pop(),
            references: [],
          };
          hashToAssetMap[md5ext] = asset;
          allAssets.push(asset);
        }
        hashToAssetMap[md5ext].references.push(data);
      }

      return allAssets;
    }

    const children = projectData.children.filter((c) => !c.listName && !c.target);
    const targets = [].concat.apply([], [projectData, children]);
    const costumes = [].concat.apply([], targets.map((c) => c.costumes || []));
    const sounds = [].concat.apply([], targets.map((c) => c.sounds || []));
    const assets = processAssets([].concat.apply([], [costumes, sounds, projectData]));
    return Promise.all(assets.map((a) => addAsset(a)))
      .then(() => {
        // We must add the project JSON at the end because it was probably changed during the loading from updating asset IDs
        result.files.push({path: 'project.json', data: JSON.stringify(projectData)});
        sortFiles(result.files);
        return result;
      });
  }

  async function fetchToken(id) {
    const metadataRequest = await fetch(`https://trampoline.turbowarp.org/proxy/projects/${id}`);
    if (metadataRequest.status === 404) {
      throw new CannotAccessProjectError("Cannot access project metadata. This probably means the project is unshared, never existed, or the ID is invalid.");
    }
    if (!metadataRequest.ok) {
      throw new Error(`Unknown error fetching project metadata: status ${metadataRequest.status}`);
    }
    const metadata = await metadataRequest.json();
    const token = metadata.project_token;
    return token;
  }

  async function fetchProjectDataWithToken(id) {
    const token = await fetchToken(id).catch((err) => {
      // For now, this is a non-critical error.
      console.error('Error fetching project token', err);
      return null;
    });
    const tokenPart = token ? `?token=${token}` : '';
    let url = `https://projects.scratch.mit.edu/${id}${tokenPart}`;
    const projectRequest = await fetch(url);
    if (projectRequest.ok) {
      return projectRequest;
    }
    if (projectRequest.status === 404) {
      throw new Error('Project does not exist but could access metadata');
    }
    throw new Error(`Could not fetch project data: status ${projectRequest.status}`);
  }

  // Loads a Scratch 3 project
  function loadScratch3Project(id) {
    const ASSETS_API = 'https://assets.scratch.mit.edu/internalapi/asset/$path/get/';

    const result = {
      title: id.toString(),
      extension: 'sb3',
      files: [],
      type: 'zip',
    };

    function addFile(data) {
      progressHooks.newTask();
      const path = data.md5ext;
      return fetch(ASSETS_API.replace('$path', path))
        .then((request) => request.arrayBuffer())
        .then((buffer) => {
          result.files.push({path: path, data: buffer});
          progressHooks.finishTask();
        });
    }

    function processAssets(assets) {
      const result = [];
      const knownIds = new Set();

      for (const i of assets) {
        // Make sure md5ext always exists.
        // https://github.com/forkphorus/forkphorus/issues/504
        if (!i.md5ext) {
          i.md5ext = i.assetId + '.' + i.dataFormat;
        }

        // Deduplicate assets.
        const id = i.md5ext;
        if (knownIds.has(id)) {
          continue;
        }
        knownIds.add(id);
        result.push(i);
      }

      return result;
    }

    progressHooks.start();
    progressHooks.newTask();

    return fetchProjectDataWithToken(id)
      .then((request) => {
        const clonedResponse = request.clone();
        return request.json()
          .catch((err) => {
            // It's not JSON. It might be a full compressed zip project.
            console.warn('Project was not JSON, trying to interpret as zip', err);
            return clonedResponse.arrayBuffer()
              .then((buffer) => JSZip.loadAsync(buffer))
              .then((zip) => zip.file('project.json').async('text'))
              .then((jsonText) => JSON.parse(jsonText));
            // For now we won't try to use the files in the zip and will just re-fetch everything from Scratch.
          });
      })
      .then((projectData) => {
        if (typeof projectData.objName === 'string') {
          throw new ProjectFormatError('Not a Scratch 3 project (found objName)', 'sb2');
        }
        if (!Array.isArray(projectData.targets)) {
          throw new Error('Not a Scratch 3 project, missing targets');
        }

        result.files.push({path: 'project.json', data: JSON.stringify(projectData)});

        const targets = projectData.targets;
        const costumes = [].concat.apply([], targets.map((t) => t.costumes || []));
        const sounds = [].concat.apply([], targets.map((t) => t.sounds || []));
        const assets = processAssets([].concat.apply([], [costumes, sounds]));

        return Promise.all(assets.map((a) => addFile(a)));
      })
      .then(() => {
        sortFiles(result.files);
        progressHooks.finishTask();
        return result;
      });
  }

  // Adds a list of files to a JSZip archive.
  // This is a convenience method to make the library less painful to use. It's not used by SBDL internally.
  // If a 'zip' type result is returned, pass result.files into here to get a Blob out.
  // progressCallback (optional) will be called when the progress changes
  function createArchive(files, progressCallback) {
    const zip = new JSZip();
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const path = file.path;
      const data = file.data;
      zip.file(path, data);
    }
    return zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
    }, function(metadata) {
      if (progressCallback) {
        progressCallback(metadata.percent / 100);
      }
    });
  }

  // Loads a project, automatically choses the loader
  function loadProject(id, type) {
    const loaders = {
      sb: loadScratch1Project,
      sb2: loadScratch2Project,
      sb3: loadScratch3Project,
    };
    type = type.toString();
    if (!(type in loaders)) {
      return Promise.reject(new Error('Unknown type: ' + type));
    }
    return loaders[type](id);
  }

  return {
    loadScratch1Project: loadScratch1Project,
    loadScratch2Project: loadScratch2Project,
    loadScratch3Project: loadScratch3Project,
    fetchProjectDataWithToken: fetchProjectDataWithToken,
    loadProject: loadProject,
    createArchive: createArchive,
    progressHooks: progressHooks,
  };
}());
