const ID = /^[0-9a-zA-Z-]{1,64}$/;

/**
 * Maps external links (widget taps, notification taps) to in-app routes. Only known
 * shapes are accepted; anything else opens Home.
 *   harmonia://home | harmonia://dates | harmonia://timeline | harmonia://memories
 *   harmonia://counter | harmonia://milestone/<id> | an in-app path "/milestone/<id>"
 */
export function routeForLink(link: string | null | undefined): string {
  if (!link) return '/tabs/home';
  let path = link;
  const scheme = /^harmonia:\/\/(.*)$/i.exec(link);
  if (scheme) path = `/${scheme[1]}`;
  path = path.split(/[?#]/)[0].replace(/\/+$/, '');
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 1) {
    switch (parts[0]) {
      case 'home':
      case 'dates':
      case 'timeline':
      case 'memories':
        return `/tabs/${parts[0]}`;
      case 'counter':
        return '/counter';
    }
  }
  if (parts.length === 2 && (parts[0] === 'milestone' || parts[0] === 'memory') && ID.test(parts[1])) {
    return `/${parts[0]}/${parts[1]}`;
  }
  return '/tabs/home';
}
