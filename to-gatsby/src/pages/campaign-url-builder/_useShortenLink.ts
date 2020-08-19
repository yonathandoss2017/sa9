import React from "react"
import { StorageKey, EventAction, EventCategory } from "../../constants"
import { useLocalStorage } from "react-use"
import { useSelector } from "react-redux"

type BitlyStorageCache = {
  // Cache starts at guid level.
  [GUID: string]:
    | {
        // Then is indexd by the longUrl
        [longLink: string]: string | undefined
      }
    | undefined
}

/**
 * Accepts a long URL and returns a promise that is resolved with its shortened
 * version, using the bitly API.
 *
 * This function memoizes its results using the provided cache & setCacheValue
 * arguments.
 */
const shortenUrl = async (
  token: string,
  longUrl: string,
  cache: BitlyStorageCache,
  setCacheValue: typeof defaultCacheSetter
): Promise<string> => {
  const user = await bitlyUser(token)
  const guid = user.default_group_guid

  const cachedLink = cache[guid]?.[longUrl]
  if (cachedLink !== undefined) {
    return cachedLink
  }

  // If the link isn't in the local cache, create it.
  const shortned = await bitlyShorten(token, longUrl, guid)
  const link = shortned.link

  updateBitlyCache(guid, longUrl, link, cache, setCacheValue)

  return link
}

const defaultCacheSetter = (value: BitlyStorageCache): void => {
  const asString = JSON.stringify(value)
  window.localStorage.setItem(StorageKey.bitlyCache, asString)
  return
}

const updateBitlyCache = (
  guid: string,
  longUrl: string,
  shortUrl: string,
  cache: BitlyStorageCache,
  setCacheValue: typeof defaultCacheSetter
): void => {
  // Initialize guid level if necessary.
  cache[guid] = cache[guid] || {}
  cache[guid]![longUrl] = shortUrl
  setCacheValue(cache)
  return
}

// https://dev.bitly.com/api-reference#createBitlink
export type ShortenResponse = {
  link: string
}
const bitlyShorten = async (
  token: string,
  longUrl: string,
  guid: string
): Promise<ShortenResponse> => {
  const url = "https://api-ssl.bitly.com/v4/shorten"

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ long_url: longUrl, group_guid: guid }),
  })

  const json = await response.json()
  return json
}

// https://dev.bitly.com/api-reference#getUser
type UserResponse = {
  default_group_guid: string
}
const bitlyUser = async (token: string): Promise<UserResponse> => {
  const url = "https://api-ssl.bitly.com/v4/user"

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  })

  const json = await response.json()
  return json
}

const NO_BITLY_CLIENT_ID =
  "A bitly clientId is required for shortening links.\nPlease run:\nyarn check-config --all\nAnd provide a value for bitlyClientId"

const WINDOW_FEATURES = [
  ["toolbar", "no"],
  ["menubar", "no"],
  ["width", "600"],
  ["height", "700"],
  ["top", "100"],
  ["left", "100"],
]
  .map(pair => pair.join("="))
  .join(", ")

type UseShortLink = () => {
  authenticated: boolean
  canShorten: boolean
  shorten: (
    longLink: string
  ) => Promise<{ shortLink: string; longLink: string }>
}
const useShortenLink: UseShortLink = () => {
  const clientId = process.env.BITLY_CLIENT_ID
  const gtag = useSelector((a: AppState) => a.gtag)
  const [token, setToken] = useLocalStorage<string>(
    StorageKey.bitlyAccessToken,
    "",
    { raw: true }
  )
  const [cache, setCache] = useLocalStorage<BitlyStorageCache>(
    StorageKey.bitlyCache,
    {}
  )

  const ensureAuth = React.useCallback(async (): Promise<string> => {
    if (token !== "") {
      return token
    }
    return new Promise(resolve => {
      if (gtag !== undefined) {
        gtag("event", EventAction.bitlyAuth, {
          event_category: EventCategory.campaignUrlBuilder,
        })
      }
      const redirectUri = `${window.location.origin}/bitly-auth`
      const url = `https://bitly.com/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}`
      const name = "Login with Bit.ly"
      // This is a bit of a hack, but it's needed to make sure the button is kept
      // up to date when the token is updated from the new window.
      const newAuthWindow = window.open(url, name, WINDOW_FEATURES)
      const storageListener = (e: StorageEvent) => {
        if (e.key === StorageKey.bitlyAccessToken && e.newValue !== null) {
          setToken(e.newValue)
          resolve(e.newValue)
          resolve()
          if (newAuthWindow !== null) {
            // Automatically close the window after the user has had enough time
            // to read it.
            setTimeout(() => {
              newAuthWindow.close()
              window.removeEventListener("storage", storageListener)
            }, 5000)
          }
        }
      }
      window.addEventListener("storage", storageListener)
    })
  }, [token, setToken, clientId, gtag])

  const shorten = React.useCallback(
    async (longLink: string) => {
      if (longLink.startsWith("https://bit.ly")) {
        throw new Error("Cannot shorten a shortlink")
      }
      if (longLink === "") {
        throw new Error("Cannot shortnen an empty string")
      }
      const token = await ensureAuth()
      const shortLink = await shortenUrl(token, longLink, cache, setCache)
      if (gtag !== undefined) {
        gtag("event", EventAction.bitlyShorten, {
          event_category: EventCategory.campaignUrlBuilder,
        })
      }
      return { shortLink, longLink }
    },
    [ensureAuth, cache, setCache, gtag]
  )

  if (clientId === undefined) {
    console.error(NO_BITLY_CLIENT_ID)
    // Return a stubbed out version that throws if you try to shorten a link.
    return {
      canShorten: false,
      authenticated: false,
      shorten: async _ => {
        throw new Error(NO_BITLY_CLIENT_ID)
      },
    }
  }

  return {
    canShorten: true,
    shorten,
    authenticated: token !== "",
  }
}

export default useShortenLink
