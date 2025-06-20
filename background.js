let INACTIVITY_LIMIT_MINUTES = 0.1;

chrome.storage.local.get(["inactivityLimit"], (data) => {
  if (typeof data.inactivityLimit==="number") {
    INACTIVITY_LIMIT_MINUTES = data.inactivityLimit ?? 0.1;
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.inactivityLimit) {
    INACTIVITY_LIMIT_MINUTES = changes.inactivityLimit.newValue;
    console.log("Updated limit to: ", INACTIVITY_LIMIT_MINUTES);
  }

  if (changes.isExtensionActive) {
    if (changes.isExtensionActive.newValue === false) {
      for (const tabId in tabTimers) {
        clearTimeout(tabTimers[tabId]);
        clearTimeout(warningTimers[tabId]);
      }
      Object.keys(tabTimers).forEach(k => delete tabTimers[k]);
      Object.keys(warningTimers).forEach(k => delete warningTimers[k]);
      Object.keys(inactivityStartTimes).forEach(k => delete inactivityStartTimes[k]);
      console.log("Extension paused: all timers cleared.");
    } else {
      chrome.tabs.query({}, (tabs) => {
        chrome.storage.local.get("ignoreDomains", (data) => {
          const ignoreList = data.ignoreDomains || [];
          tabs.forEach(tab => {
            if (tab.id && !tab.pinned && !tab.audible && !tab.active && tab.url) {
              const isIgnored = ignoreList.some(item => item.url === tab.url);
              if (!isIgnored) {
                inactivityStartTimes[tab.id] = Date.now();
                resetTimer(tab.id);
              }
            }
          });
        });
      });
      console.log("Extension resumed: timers restarted.");
    }
  }

  if (changes.ignoreDomains) {
    const newIgnoreURLs = changes.ignoreDomains.newValue || [];

    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((tab) => {
        if (!tab.url) return;

        if (!newIgnoreURLs.some(item => item.url === tab.url)) {
          clearTimeout(tabTimers[tab.id]);
          clearTimeout(warningTimers[tab.id]);
          delete tabTimers[tab.id];
          delete warningTimers[tab.id];
          delete inactivityStartTimes[tab.id];

          chrome.notifications.clear(`warn-${tab.id}`);

          setTimeout(() => {
            inactivityStartTimes[tab.id] = Date.now();
            resetTimer(tab.id);
          }, 500);
        } 
      });
    });
  }
});

const tabTimers = {};
const warningTimers = {};
const inactivityStartTimes = {};
let lastActiveTabId = null;

chrome.tabs.onActivated.addListener(({ tabId }) => {
  const prevTabId = lastActiveTabId;
  lastActiveTabId = tabId;

  clearTimeout(tabTimers[tabId]);
  clearTimeout(warningTimers[tabId]);
  delete inactivityStartTimes[tabId];

  if (prevTabId !== null && prevTabId !== tabId) {
    chrome.storage.local.get("ignoreDomains", (data) => {
      const ignoreList = data.ignoreDomains || [];

      chrome.tabs.get(prevTabId, (tab) => {
        if (chrome.runtime.lastError || !tab || !tab.url) return;

        const isIgnored = ignoreList.some(item => item.url === tab.url);
        const isSystemTab = tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-devtools://");

        if (!tab.pinned && !tab.audible && !isSystemTab && !isIgnored) {
          clearTimeout(tabTimers[prevTabId]);
          clearTimeout(warningTimers[prevTabId]);
          delete inactivityStartTimes[prevTabId];

          inactivityStartTimes[prevTabId] = Date.now();
          resetTimer(prevTabId);
        }
      });
    });
  }
});


chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") {
    clearTimeout(tabTimers[tabId]);
    clearTimeout(warningTimers[tabId]);
    delete inactivityStartTimes[tabId];
    resetTimer(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTimeout(tabTimers[tabId]);
  clearTimeout(warningTimers[tabId]);
  delete tabTimers[tabId];
  delete warningTimers[tabId];
  delete inactivityStartTimes[tabId];
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (notificationId.startsWith("warn-") && buttonIndex === 0) {
    const tabId = parseInt(notificationId.split("-")[1]);
    if (tabId) {
      // Fully cancel any scheduled timeouts
      clearTimeout(tabTimers[tabId]);
      clearTimeout(warningTimers[tabId]);
      delete tabTimers[tabId];
      delete warningTimers[tabId];
      delete inactivityStartTimes[tabId];

      // Clear the warning notification
      chrome.notifications.clear(notificationId);

      // Postpone inactivity tracking with a small buffer (optional)
      setTimeout(() => {
        inactivityStartTimes[tabId] = Date.now();
        resetTimer(tabId);
        console.log(`Tab ${tabId} warning overridden. New timer started.`);
      }, 500); // slight delay ensures previous timer is fully cleared
    }
  }
});


function resetTimer(tabId) {
  console.log(`Resetting timer for tab ${tabId}, current limit: ${INACTIVITY_LIMIT_MINUTES} minutes`);

  clearTimeout(tabTimers[tabId]);
  clearTimeout(warningTimers[tabId]);

  chrome.storage.local.get(["isExtensionActive", "ignoreDomains"], (data) => {
    if (data.isExtensionActive === false) {
      console.log(`Extension paused, no timer for tab ${tabId}`);
      return;
    }

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab || !tab.url) return;

      const url = tab.url;
      const isSystemTab = url.startsWith("chrome://") || url.startsWith("chrome-devtools://");
      if (isSystemTab) return;

      if (data.ignoreDomains?.some(item => item.url === url)) {
        console.log(`Ignoring tab ${tabId} with URL: ${url}`);
        return;
      }

      const now = Date.now();
      if (!inactivityStartTimes[tabId]) {
        inactivityStartTimes[tabId] = now;
      }

      const elapsedMs = now - inactivityStartTimes[tabId];
      const inactivityLimitMs = INACTIVITY_LIMIT_MINUTES * 60 * 1000;

      if (elapsedMs >= inactivityLimitMs) {
        if (!tab.active && !tab.audible && !tab.pinned) {
          chrome.tabs.remove(tabId, () => {
            console.log(`Tab ${tabId} closed due to inactivity.`);
            delete inactivityStartTimes[tabId];
          });
        }
        return;
      }

      const remainingMs = inactivityLimitMs - elapsedMs;
      const warningTimeMs = Math.max(0, remainingMs - 10000);

      warningTimers[tabId] = setTimeout(() => {
        chrome.storage.local.get("isExtensionActive", (data) => {
          if (data.isExtensionActive === false) return;
          const remainingSeconds = Math.ceil(remainingMs / 1000);
          showWarning(tabId, remainingSeconds >= 10 ? 10 : remainingSeconds);
        });
      }, warningTimeMs);

      tabTimers[tabId] = setTimeout(() => {
        chrome.storage.local.get("isExtensionActive", (data) => {
          if (data.isExtensionActive === false) return;

          chrome.tabs.get(tabId, (t) => {
            if (chrome.runtime.lastError || !t) return;
            if (t.active || t.audible || t.pinned) {
              delete inactivityStartTimes[tabId];
              return;
            }

            chrome.tabs.remove(tabId, () => {
              console.log(`Tab ${tabId} closed after full timeout.`);
              delete inactivityStartTimes[tabId];
            });
          });
        });
      }, remainingMs);
    });
  });
}

function showWarning(tabId, remainingSeconds) {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    if (tab.active || tab.audible || tab.pinned) return;

    chrome.notifications.clear(`warn-${tabId}`, () => {
      chrome.notifications.create(`warn-${tabId}`, {
        type: "basic",
        iconUrl: "icon.png",
        title: "Tab Inactive",
        message: `"${tab.title}" will close in ${remainingSeconds} seconds due to inactivity.`,
        buttons: [{ title: "Don't close now" }],
        priority: 2,
      });
    });
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "resetTimer" && typeof message.tabId === "number") {
    resetTimer(message.tabId);
  }
  if (message.action === "stopTimer" && typeof message.tabId === "number") {
    clearTimeout(tabTimers[message.tabId]);
    clearTimeout(warningTimers[message.tabId]);
    delete tabTimers[message.tabId];
    delete warningTimers[message.tabId];
    delete inactivityStartTimes[message.tabId];
    chrome.notifications.clear(`warn-${message.tabId}`);
    console.log(`Stopped tracking tab ${message.tabId} due to ignore list.`);
  }

  if (message.action === "resetAllTabTimers") {
    chrome.storage.local.get("ignoreDomains", (data) => {
      const ignoreList = data.ignoreDomains || [];
      chrome.tabs.query({}, (tabs) => {
        for( const tab of tabs){

          if (tab.id && !tab.pinned && !tab.audible && tab.status==="complete" && tab.url && !tab.url.startsWith("chrome://") && !ignoreList.some(item => item.url === tab.url)) {
            clearTimeout(tabTimers[tab.id]);
            clearTimeout(warningTimers[tab.id]);
            inactivityStartTimes[tab.id] = Date.now();
            resetTimer(tab.id);
          }
        }
      })
    })
  }
});
