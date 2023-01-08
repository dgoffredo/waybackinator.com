#!/usr/bin/env node

const http = require('node:http');
const https = require('node:https');
const process = require('node:process');
const querystring = require('node:querystring');

const httpsAgent = new https.Agent({keepAlive : true});

// Naughty bots request all kinds of garbage.  A lot of it doesn't even look
// like a web resource, e.g. "debug/default/view?panel=config".
// `isPlausible` checks the prefix of `url` against a regex that approximates
// a valid HTTP scheme and authority.
function isPlausible(url) {
  return (/^(https?:\/\/)?[^.\/]+(\.[^.\/]+)+\.?(\/|$)/).test(url);
}

// url -> {archiveURL: string, error: string}
function fetchArchiveURL(url, callback) {
  const requestOptions = {
    agent : httpsAgent,
    protocol : 'https:',
    hostname : 'archive.org',
    path : `/wayback/available?${querystring.encode({url})}`
  };

  https.request(requestOptions)
      .on('response',
          response => {
            const status = response.statusCode;
            if (status >= 300) {
              return callback({
                error : `archive.org replied with status ${status} ${
                    response.statusMessage}`
              });
            }

            let body = '';
            response.on('data', chunk => body += chunk).on('end', () => {
              console.log('archive.org response body: ', body);
              try {
                // const {available, url} =
                // JSON.parse(body).archived_snapshots.closest;
                const snapshots = JSON.parse(body).archived_snapshots;
                const snapshot = snapshots.closest;
                if (!snapshot || !snapshot.available) {
                  return callback({
                    error :
                        'That URL is not available via the internet archive API.'
                  });
                }
                return callback({archiveURL : snapshot.url});
              } catch (error) {
                console.error(error);
                return callback({
                  error :
                      `Error occurred processing archive.org response:\n${body}`
                });
              }
            });
          })
      .on('error', error => { return callback({error : error.toString()}); })
      .end();
}

function escapeForHTML(raw) {
  return raw.replace(
      /["<&]/, char => ({'"' : '&quot;', '<' : '&lt;', '&' : '&amp;'}[char]));
}

// LRU cache
const cache = (() => {
  const evictionMilliseconds = 1000 * 60 * 60;
  const maxNumEntries = 1024 * 32;
  const entries = {}; // input url -> {output url, Date.now() when added}
  let numEntries = 0; // number of elements in `entries`
  // singly-linked list for LRU eviction
  // Each element is {url, addedTime, next}
  let additionHead; // first element in singly-linked list for LRU eviction
  let additionTail; // last element in singly-linked list for LRU eviction
  return {
    // url -> archiveURL | undefined
    lookup : url => {
      const now = Date.now();
      const entry = entries[url];
      if (entry === undefined) {
        return;
      }

      const {archiveURL, addedTime} = entry;
      if (now - addedTime >= evictionMilliseconds) {
        delete entries[url];
        --numEntries;
        return;
      }

      return archiveURL;
    },
    // (inputURL, archiveURL) -> undefined
    set : (inputURL, archiveURL) => {
      const now = Date.now();
      while (numEntries === maxNumEntries) {
        const {url, addedTime, next} = additionHead;
        const entry = entries[url];
        if (entry.addedTime === addedTime) {
          delete entries[url];
          --numEntries;
        }
        additionHead = next;
      }
      entries[inputURL] = {archiveURL, addedTime : now};
      const addition = {url : inputURL, addedTime : now};
      if (!additionHead) {
        additionHead = addition;
      } else if (additionTail) {
        additionTail.next = addition;
        additionTail = addition;
      } else {
        additionTail = addition;
      }
      ++numEntries;
    }
  };
})();

function getArchiveURL(url, callback) {
  // Check the cache.
  let archiveURL = cache.lookup(url);
  if (archiveURL !== undefined) {
    console.log(`retrieved ${url} from cache`);
    return callback({archiveURL, inCache : true});
  }

  return fetchArchiveURL(url, callback);
}

function onRequest(request, response) {
  let url = request.url.slice(1); // without leading "/"
  if (url.slice(-1) === '?') {
    // Empty HTML form might leave a trailing empty query.
    url = url.slice(0, -1);
  }
  console.log('Received request for url: ', url);

  if (!isPlausible(url)) {
    return deliverError(response, 'Your query is bad and you should feel bad.');
  }

  getArchiveURL(url, ({archiveURL, inCache, error}) => {
    if (error !== undefined) {
      return deliverError(response, error);
    }

    if (!inCache) {
      cache.set(url, archiveURL);
    }
    deliverSuccess(response, archiveURL);
  });
}

function deliverSuccess(response, archiveURL) {
  response.setHeader('Content-Type', 'text/html');
  response.writeHead(200);
  const escapedURL = escapeForHTML(archiveURL);
  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>waybackinator</title>
  </head>
  <body>
   <p><a href="${escapedURL}">${escapedURL}</a></p>
  </body>
</html>
`;
  response.end(html);
}

function deliverError(response, error) {
  response.setHeader('Content-Type', 'text/html');
  response.writeHead(404);
  const escapedError = escapeForHTML(error);
  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>waybackinator</title>
  </head>
  <body>
   <p>${escapedError}</p>
  </body>
</html>
`;
  response.end(html);
}

const host = '0.0.0.0';
const port = 8000;
const server = http.createServer(onRequest);
server.listen({host, port})
    .on('listening', () => console.log(`Listening on ${host}:${port}`));

process.on('SIGTERM', function() { server.close(() => process.exit(0)); });
