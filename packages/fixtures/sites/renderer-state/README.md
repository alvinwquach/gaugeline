# renderer-state

An invented bakery (Quillfeather Bakery) for the click observer's tests of what a click may carry and where it may go (render-02). Nothing here is a real business.

| Link   | What it does                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------- |
| Set    | Writes a cookie, local storage and session storage when clicked                                                          |
| Seen   | Reports what cookie and storage it can see: each click must start with none of what `Set` wrote                          |
| Redir  | Goes to a page on this site that redirects (302) to another site: the other site is never asked                          |
| Swap   | Has its address changed to a `javascript:` address by a script after the page loads: never clicked                       |
| Hover  | Swaps itself for a form button when the pointer arrives: the click must not land on the button, and the form is never submitted |
| Logout | A plain link to `/logout.html` on this site: the plan lists it, so it is clicked (a GET with no credentials)             |

`redirected.example` is never answered: the tests assert nothing is asked of it.
