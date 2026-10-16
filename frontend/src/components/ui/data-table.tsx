import { cn } from "@/lib/utils";

/**
 * The admin table (04-frontend.md "Admin": denser tables; every admin list reuses this). A real
 * `<table>` with a caption, so screen readers get rows and column headers; on a narrow phone it
 * scrolls sideways inside its own box instead of squashing the columns.
 */
export type Column<T> = {
  /** Stable key for React and for `data-col` (handy in tests). */
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /** Extra classes for both the `<th>` and its `<td>`s (width, alignment). */
  className?: string;
  /** The row's header cell (`<th scope="row">`): usually the name column. */
  rowHeader?: boolean;
};

export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  empty,
  rowProps,
  className,
}: {
  /** Visible above the table and its accessible name. */
  caption: React.ReactNode;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Shown in one full-width row when `rows` is empty. */
  empty?: React.ReactNode;
  /** Per-row attributes (`data-*`, a muted class for inactive rows). */
  rowProps?: (
    row: T,
  ) => React.HTMLAttributes<HTMLTableRowElement> & Record<`data-${string}`, string>;
  className?: string;
}) {
  return (
    <div className={cn("overflow-x-auto rounded-xl ring-1 ring-foreground/10", className)}>
      <table className="w-full border-collapse text-left text-sm">
        <caption className="bg-card px-3 py-2 text-left text-base font-semibold">{caption}</caption>
        <thead className="bg-muted/60 text-xs tracking-wide text-muted-foreground uppercase">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn("px-3 py-2 font-medium whitespace-nowrap", column.className)}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-4 text-muted-foreground">
                {empty ?? "Nothing here yet."}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const { className: rowClass, ...props } = rowProps?.(row) ?? {};
              return (
                <tr
                  key={rowKey(row)}
                  className={cn("border-t border-border align-middle", rowClass)}
                  {...props}
                >
                  {columns.map((column) =>
                    column.rowHeader ? (
                      <th
                        key={column.key}
                        scope="row"
                        data-col={column.key}
                        className={cn("px-3 py-2 font-medium", column.className)}
                      >
                        {column.cell(row)}
                      </th>
                    ) : (
                      <td
                        key={column.key}
                        data-col={column.key}
                        className={cn("px-3 py-2", column.className)}
                      >
                        {column.cell(row)}
                      </td>
                    ),
                  )}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
