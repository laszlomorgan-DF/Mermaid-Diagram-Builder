USE [ShopDb]
GO
/****** Object:  Schema [sales]    Script Date: 11/11/2026 09:12:44 ******/
CREATE SCHEMA [sales]
GO
/****** Object:  Table [dbo].[Customers]    Script Date: 11/11/2026 09:12:44 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Customers](
	[CustomerID] [int] IDENTITY(1,1) NOT NULL,
	[Email] [nvarchar](255) NOT NULL,
	[Display Name] [nvarchar](100) NULL,
	[Balance] [decimal](10, 2) NOT NULL,
	[Notes] [nvarchar](max) NULL,
	[RowVer] [timestamp] NOT NULL,
 CONSTRAINT [PK_Customers] PRIMARY KEY CLUSTERED
(
	[CustomerID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY],
 CONSTRAINT [UQ_Customers_Email] UNIQUE NONCLUSTERED
(
	[Email] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
/****** Object:  Table [sales].[Orders]    Script Date: 11/11/2026 09:12:44 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [sales].[Orders](
	[OrderID] [bigint] IDENTITY(1,1) NOT NULL,
	[CustomerID] [int] NOT NULL,
	[OrderedAt] [datetime2](7) NOT NULL,
	[Status] [varchar](20) NOT NULL,
 CONSTRAINT [PK_Orders] PRIMARY KEY CLUSTERED
(
	[OrderID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [sales].[OrderLines]    Script Date: 11/11/2026 09:12:44 ******/
CREATE TABLE [sales].[OrderLines](
	[OrderID] [bigint] NOT NULL,
	[LineNo] [smallint] NOT NULL,
	[ProductCode] [char](8) NOT NULL,
	[Qty] [int] NOT NULL,
	[UnitPrice] [money] NOT NULL,
 CONSTRAINT [PK_OrderLines] PRIMARY KEY CLUSTERED
(
	[OrderID] ASC,
	[LineNo] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[Products]    Script Date: 11/11/2026 09:12:44 ******/
CREATE TABLE [dbo].[Products](
	[ProductCode] [char](8) NOT NULL,
	[Name] [nvarchar](200) NOT NULL,
	[ListPrice] [numeric](12, 4) NULL,
PRIMARY KEY CLUSTERED
(
	[ProductCode] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [sales].[Shipments]    Script Date: 11/11/2026 09:12:44 ******/
CREATE TABLE [sales].[Shipments](
	[ShipmentID] [int] IDENTITY(1,1) NOT NULL,
	[OrderID] [bigint] NOT NULL,
	[LineNo] [smallint] NOT NULL,
	[ShippedAt] [datetime2](7) NULL,
	[CarrierRef] [uniqueidentifier] NULL,
 CONSTRAINT [PK_Shipments] PRIMARY KEY CLUSTERED
(
	[ShipmentID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Index [IX_Orders_CustomerID]    Script Date: 11/11/2026 09:12:44 ******/
CREATE NONCLUSTERED INDEX [IX_Orders_CustomerID] ON [sales].[Orders]
(
	[CustomerID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
CREATE UNIQUE NONCLUSTERED INDEX [UX_Shipments_CarrierRef] ON [sales].[Shipments]
(
	[CarrierRef] ASC
)
WHERE ([CarrierRef] IS NOT NULL)
WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
ALTER TABLE [dbo].[Customers] ADD  CONSTRAINT [DF_Customers_Balance]  DEFAULT ((0)) FOR [Balance]
GO
ALTER TABLE [sales].[Orders] ADD  DEFAULT ('NEW') FOR [Status]
GO
ALTER TABLE [sales].[Orders]  WITH CHECK ADD  CONSTRAINT [FK_Orders_Customers] FOREIGN KEY([CustomerID])
REFERENCES [dbo].[Customers] ([CustomerID])
GO
ALTER TABLE [sales].[Orders] CHECK CONSTRAINT [FK_Orders_Customers]
GO
ALTER TABLE [sales].[OrderLines]  WITH CHECK ADD  CONSTRAINT [FK_OrderLines_Orders] FOREIGN KEY([OrderID])
REFERENCES [sales].[Orders] ([OrderID])
ON DELETE CASCADE
GO
ALTER TABLE [sales].[OrderLines] CHECK CONSTRAINT [FK_OrderLines_Orders]
GO
ALTER TABLE [sales].[OrderLines]  WITH NOCHECK ADD  CONSTRAINT [FK_OrderLines_Products] FOREIGN KEY([ProductCode])
REFERENCES [dbo].[Products] ([ProductCode])
GO
ALTER TABLE [sales].[OrderLines] NOCHECK CONSTRAINT [FK_OrderLines_Products]
GO
ALTER TABLE [sales].[Shipments]  WITH CHECK ADD  CONSTRAINT [FK_Shipments_OrderLines] FOREIGN KEY([OrderID], [LineNo])
REFERENCES [sales].[OrderLines] ([OrderID], [LineNo])
GO
ALTER TABLE [sales].[Shipments] CHECK CONSTRAINT [FK_Shipments_OrderLines]
GO
ALTER TABLE [sales].[OrderLines]  WITH CHECK ADD  CONSTRAINT [CK_OrderLines_Qty] CHECK  (([Qty]>(0)))
GO
ALTER TABLE [sales].[OrderLines] CHECK CONSTRAINT [CK_OrderLines_Qty]
GO
/****** Object:  View [sales].[vOpenOrders]    Script Date: 11/11/2026 09:12:44 ******/
CREATE VIEW [sales].[vOpenOrders] AS
SELECT o.OrderID, c.Email FROM sales.Orders o JOIN dbo.Customers c ON c.CustomerID = o.CustomerID WHERE o.Status <> 'DONE'
GO
CREATE PROCEDURE [dbo].[usp_Touch] @id int
AS
BEGIN
	SET NOCOUNT ON;
	UPDATE dbo.Customers SET Notes = N'touched; ok' WHERE CustomerID = @id;
END
GO
