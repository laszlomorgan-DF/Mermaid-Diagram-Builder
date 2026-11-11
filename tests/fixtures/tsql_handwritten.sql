-- Hand-written T-SQL migration: no GO separators, semicolons used inconsistently.
IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'hr') EXEC('CREATE SCHEMA hr')

CREATE TABLE hr.Departments (
    DepartmentId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Departments PRIMARY KEY,
    Name NVARCHAR(100) NOT NULL UNIQUE,
    ParentDepartmentId INT NULL REFERENCES hr.Departments(DepartmentId),
    CostCentre CHAR(6) NULL
)
CREATE TABLE hr.Employees (
    EmployeeId INT IDENTITY PRIMARY KEY,
    DepartmentId INT NOT NULL FOREIGN KEY REFERENCES hr.Departments(DepartmentId) ON DELETE NO ACTION,
    ManagerId INT NULL,
    FirstName NVARCHAR(50) NOT NULL,
    LastName NVARCHAR(50) NOT NULL,
    FullName AS (FirstName + N' ' + LastName) PERSISTED,
    Salary DECIMAL(12, 2) NULL CHECK (Salary >= 0),
    [Order] INT NULL,
    [Weird]]Name] VARCHAR(10) NULL,
    CompanyCarId INT NULL,
    CONSTRAINT FK_Employees_Manager FOREIGN KEY (ManagerId) REFERENCES hr.Employees (EmployeeId)
);

CREATE TABLE dbo.EmployeeBadges (
    EmployeeId INT NOT NULL PRIMARY KEY,
    BadgeNo VARCHAR(20) NOT NULL,
    CONSTRAINT FK_Badge_Employee FOREIGN KEY (EmployeeId) REFERENCES hr.Employees (EmployeeId)
)
ALTER TABLE hr.Employees ADD HiredOn DATE NULL, TerminatedOn DATE NULL
ALTER TABLE hr.Employees ADD CONSTRAINT FK_Employees_CompanyCar FOREIGN KEY (CompanyCarId) REFERENCES fleet.CompanyCars (CarId);
ALTER TABLE hr.Payroll ADD Bonus MONEY NULL;
EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'People employed by us; includes "contractors"', @level0type = N'SCHEMA', @level0name = N'hr', @level1type = N'TABLE', @level1name = N'Employees';
EXEC sp_addextendedproperty N'MS_Description', N'Gross annual salary', N'SCHEMA', N'hr', N'TABLE', N'Employees', N'COLUMN', N'Salary'
SET IDENTITY_INSERT hr.Departments ON
INSERT INTO hr.Departments (DepartmentId, Name) VALUES (1, N'Head office; main')
SET IDENTITY_INSERT hr.Departments OFF
MERGE INTO something USING other ON 1 = 1 WHEN MATCHED THEN DELETE;
WAITFOR DELAY '00:00:01'
