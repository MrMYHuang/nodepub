var fs = require('fs'),
  path = require('path'),
  zip = require('archiver'),
  _ = require('lodash'),
  moment = require('moment'),
  asyncJs = require('async'),
  structuralFiles = require('./constituents/structural.js'),
  markupFiles = require('./constituents/markup.js');

function document(metadata, coverImage, generateContentsCallback) {
  var self = this;
  self.CSS = "";
  self.sections = [];
  self.images = [];
  self.metadata = metadata;
  self.generateContentsCallback = generateContentsCallback;
  self.filesForTOC = [];

  // Basic validation.
  var required = ["id", "title", "author", "genre"];
  if (metadata == null) throw "Missing metadata";
  _.each(required, function (field) {
    var prop = metadata[field];
    if (prop == null || typeof (prop) == "undefined" || prop.toString().trim() == "")
      throw `Missing metadata: ${  field}`;
  });
  if (typeof coverImage === "undefined") {
    throw "Missing cover image"
  }

  /* PUBLIC */

  // Add a new section entry (usually a chapter) with the given title and
  // (HTML) body content. Optionally excludes it from the contents page.
  // If it is Front Matter then it will appear before the contents page.
  self.addSection = function (title, content, excludeFromContents, isFrontMatter) {
    self.sections.push({
      title: title,
      content: content,
      excludeFromContents: excludeFromContents ? excludeFromContents : false,
      isFrontMatter: isFrontMatter ? isFrontMatter : false
    });
  };

  // Add a CSS file to the EPUB. This will be shared by all sections.
  self.addCSS = function (content) {
    self.CSS = content;
  };

  // Gets the number of sections added so far.
  self.getSectionCount = function () {
    return self.sections.length;
  };

  // Gets the files needed for the EPUB, as an array of objects.
  // Note that 'compress:false' MUST be respected for valid EPUB files.
  self.getFilesForEPUB = function (cb) {
    if (!cb) { throw new Error('getFilesForEPUB requires a callback.'); }

    var syncFiles = [];
    var asyncFiles = [];

    // Required files.
    syncFiles.push({ name: 'mimetype', folder: '', compress: false, content: getMimetype() });
    syncFiles.push({ name: 'container.xml', folder: 'META-INF', compress: true, content: getContainer(self) });
    syncFiles.push({ name: 'ebook.opf', folder: 'OEBPF', compress: true, content: getOPF(self) });
    syncFiles.push({ name: 'navigation.ncx', folder: 'OEBPF', compress: true, content: getNCX(self) });
    syncFiles.push({ name: 'cover.xhtml', folder: 'OEBPF', compress: true, content: getCover(self) });

    // Optional files.
    syncFiles.push({ name: 'ebook.css', folder: 'OEBPF/css', compress: true, content: getCSS(self) });
    for (var i = 1; i <= self.sections.length; i++) {
      syncFiles.push({ name: `s${  i  }.xhtml`, folder: 'OEBPF/content', compress: true, content: getSection(self, i) });
    }
    // Table of contents markup.
    syncFiles.push({ name: 'toc.xhtml', folder: 'OEBPF/content', compress: true, content: getTOC(self) });

    // Extra images.
    asyncFiles.push({ name: 'cover.png', folder: 'OEBPF/images', compress: true, content: coverImage });
    _.each(self.metadata.images, function (image) {
      var imageFilename = path.basename(image);
      asyncFiles.push({ name: imageFilename, folder: 'OEBPF/images', compress: true, content: image });
    });

    asyncJs.map(asyncFiles, function (file, asyncCb) {
      fs.readFile(file.content, function (err, data) {
        file.content = data;
        asyncCb(err, file);
      })
    }, function (err, results) {
      if (err) {
        cb(err);
      } else {
        var files = syncFiles.concat(results);
        cb(null, files);
      }
    });
  };

  // Writes the files needed for the EPUB into a folder structure.
  // Note that for valid EPUB files the 'mimetype' MUST be the first entry in an EPUB and uncompressed.
  self.writeFilesForEPUB = function (folder, cb) {
    if (!cb) { throw new Error('writeFilesForEPUB requires a callback.'); }
    self.getFilesForEPUB(function (filesErr, files) {
      if (filesErr) { cb(filesErr); }
      makeFolder(folder, function (folderErr) {
        if (folderErr) { cb(folderErr); }
        asyncJs.each(files, function (file, asyncDone) {
          if (file.folder.length > 0) {
            makeFolder(`${folder  }/${  file.folder}`, function () {
              fs.writeFile(`${folder  }/${  file.folder  }/${  file.name}`, file.content, asyncDone);
            });
          } else {
            fs.writeFile(`${folder  }/${  file.name}`, file.content, asyncDone);
          }
        }, function (err) {
          cb(err);
        });
      });
    });
  };

  // Writes the EPUB. The filename should not have an extention.
  self.writeEPUB = function (onError, folder, filename, onSuccess) {
    try {
      self.getFilesForEPUB(function (err, files) {
        makeFolder(folder, function (err) {
          if (err) { throw err; }
          var output = fs.createWriteStream(`${folder  }/${  filename  }.epub`);
          var archive = zip('zip', { store: false });

          // Some end-state handlers.
          output.on('close', function () {
            if (typeof (onSuccess) == 'function') {
              onSuccess(null);
            }
          });
          archive.on('error', function (err) {
            throw err;
          });
          archive.pipe(output);

          // Write the file contents.
          for (var i in files) {
            if (files[i].folder.length > 0) {
              archive.append(files[i].content, { name: `${files[i].folder  }/${  files[i].name}`, store: !files[i].compress });
            } else {
              archive.append(files[i].content, { name: files[i].name, store: !files[i].compress });
            }
          }

          // Done.
          archive.finalize();
        });
      });
    } catch (err) {
      if (typeof (onError) == 'function') {
        onError(err);
      }
    }
  };
  return self;
}

exports.document = document;



/* PRIVATE */

// Replace a single tag.
function tagReplace(original, tag, value) {
  var fullTag = `[[${  tag  }]]`;
  return original.split(fullTag).join(value ? value : '');
}

// Do all in-line replacements needed.
function replacements(document, original) {
  var modified = moment().format('YYYY-MM-DD');
  var result = original;
  result = tagReplace(result, 'EOL', '\n');
  result = tagReplace(result, 'ID', document.metadata.id);
  result = tagReplace(result, 'TITLE', document.metadata.title);
  result = tagReplace(result, 'SERIES', document.metadata.series);
  result = tagReplace(result, 'SEQUENCE', document.metadata.sequence);
  result = tagReplace(result, 'COPYRIGHT', document.metadata.copyright);
  result = tagReplace(result, 'LANGUAGE', document.metadata.language);
  result = tagReplace(result, 'FILEAS', document.metadata.fileAs);
  result = tagReplace(result, 'AUTHOR', document.metadata.author);
  result = tagReplace(result, 'PUBLISHER', document.metadata.publisher);
  result = tagReplace(result, 'DESCRIPTION', document.metadata.description);
  result = tagReplace(result, 'PUBLISHED', document.metadata.published);
  result = tagReplace(result, 'GENRE', document.metadata.genre);
  result = tagReplace(result, 'TAGS', document.metadata.tags);
  result = tagReplace(result, 'CONTENTS', document.metadata.contents);
  result = tagReplace(result, 'SOURCE', document.metadata.source);
  result = tagReplace(result, 'MODIFIED', modified);
  return result;
}

// Provide the contents of the mimetype file (which should not be compressed).
function getMimetype() {
  return 'application/epub+zip';
}

// Provide the contents of the container XML file.
function getContainer(document) {
  var content = structuralFiles.getContainer(document);
  return replacements(document, replacements(document, content));
}

// Provide the contents of the OPF (spine) file.
function getOPF(document) {
  var content = structuralFiles.getOPF(document);
  return replacements(document, replacements(document, content));
}

// Provide the contents of the NCX file.
function getNCX(document) {
  var content = structuralFiles.getNCX(document);
  return replacements(document, replacements(document, content));
}

// Provide the contents of the TOC file.
function getTOC(document) {
  var content = "";
  if (document.generateContentsCallback) {
    var callbackContent = document.generateContentsCallback(document.filesForTOC);
    content = markupFiles.getContents(document, callbackContent);
  } else {
    content = markupFiles.getContents(document);
  }
  return replacements(document, replacements(document, content));
}

// Provide the contents of the cover HTML enclosure.
function getCover(document) {
  var content = markupFiles.getCover();
  return replacements(document, replacements(document, content));
}

// Provide the contents of the CSS file.
function getCSS(document) {
  var content = document.CSS;
  return replacements(document, replacements(document, content));
}

// Provide the contents of a single section's HTML.
function getSection(document, sectionNumber) {
  var content = markupFiles.getSection(document, sectionNumber);
  return replacements(document, replacements(document, content));
}

// Create a folder, throwing an error only if the error is not that
// the folder already exists. Effectively creates if not found.
function makeFolder(path, cb) {
  if (cb) {
    fs.mkdir(path, function (err) {
      if (err && err.code != 'EEXIST') {
        throw err;
      }
      cb();
    });
  }
}
