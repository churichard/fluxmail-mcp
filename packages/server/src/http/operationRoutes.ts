export interface OperationRoute {
  method: string;
  path: string;
  operationId: string;
}

function matchesOperationRoute(template: string, path: string): boolean {
  const templateParts = template.split('/');
  const pathParts = path.split('/');
  return (
    templateParts.length === pathParts.length &&
    templateParts.every((part, index) =>
      part.startsWith('{') && part.endsWith('}') ? Boolean(pathParts[index]) : part === pathParts[index],
    )
  );
}

/** Resolve a request to its public OpenAPI operation without retaining path parameters. */
export function operationIdForRequest(
  routes: readonly OperationRoute[],
  method: string,
  path: string,
): string | undefined {
  const normalizedMethod = method.toLowerCase();
  return routes.find((route) => route.method === normalizedMethod && matchesOperationRoute(route.path, path))
    ?.operationId;
}
