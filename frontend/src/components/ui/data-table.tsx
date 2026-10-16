import { cn } from "cn";

/**
 * The admin table primitive (04-frontend.md: "New admin table → reuse the DataTable
 * primitive"). Deliberately small: a captioned, horizontally scrollable table with typed
 * columns. Sorting and paging stay with the caller, which owns the query.
 */
export type Column<Row> = {
  key: string;
  header: React.ReactNode;
  cell: (row: Row) => React.ReactNode;
  className?: string;
};

export function DataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  empty,
  className,
  ...props
}: {
  caption: string;
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  empty: React.ReactNode;
  className?: string;
} & Omit<React.ComponentProps<"div">, "children">) {
  return (
    <div
      className={cn("overflow-x-auto rounded-xl ring-1 ring-foreground/10", className)}
      {...props}
    >
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn("px-3 py-2 font-medium", column.className)}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-6 text-center text-muted-foreground">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)} className="border-t border-foreground/10">
                {columns.map((column) => (
                  <td key={column.key} className={cn("px-3 py-2 align-middle", column.className)}>
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
